import { TLS_BASENAME, DO_CONFIG_PATH } from "./constants.ts";
import { uniqueString } from "https://deno.land/x/uniquestring/mod.ts";

export async function checkEnvironment() {
  console.log("!! Checking Environment Variables...");
  const varsNeeded = ["EMAIL", "BASE_DOMAIN", "CLUSTER_NAME"];

  for (const varName of varsNeeded) {
    if (Deno.env.get(varName)) continue;
    console.error(`Missing environment variable: '${varName}'`);
    Deno.exit(1);
  }

  const cfgFile = Deno.run({ cmd: ["cat", DO_CONFIG_PATH], stdout: "piped" });
  const status = await cfgFile.status();
  if (!status) {
    console.error(`Failed to read ${DO_CONFIG_PATH}`);
    Deno.exit(1);
  }
  if (Deno.env.get("TEST")) {
    console.log(`Running in test mode using '--test-cert'...`);
  }
}

export async function setAdditionalVars() {
  const token_file = await Deno.readFile("/var/run/secrets/kubernetes.io/serviceaccount/token");
  const sa_token = new TextDecoder("utf-8").decode(token_file);

  Deno.env.set("SA_TOKEN", sa_token);

  const base_domain = Deno.env.get("BASE_DOMAIN")!.trim();
  const cluster_name = Deno.env.get("CLUSTER_NAME")!.trim();
  const cluster_domain = cluster_name + "." + base_domain;

  Deno.env.set("CLUSTER_DOMAIN", cluster_domain);

  Deno.env.set("TLS_SECRET_NAME", TLS_BASENAME + "-" + uniqueString(5).toLowerCase());

  const currentIngress = await fetch(
    `https://api.${cluster_domain}:6443/apis/operator.openshift.io/v1/namespaces/openshift-ingress-operator/ingresscontrollers/default`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${sa_token}`,
      },
    }
  );
  if (currentIngress.status !== 200) {
    console.log(`Status getting current ingress: ${currentIngress.status}`);
    Deno.exit(1);
  }
  const data = await currentIngress.json();
  Deno.env.set("OLD_CERTS", data.spec.defaultCertificate.name);
}

export async function generateCertificates() {
  console.log("!! Generating Certificates..");
  const email = Deno.env.get("EMAIL")!.trim();
  const domain = Deno.env.get("BASE_DOMAIN")!.trim();
  const cluster_name = Deno.env.get("CLUSTER_NAME")!.trim();

  const cmd = [
    "certbot-3",
    "certonly",
    "--non-interactive",
    "--agree-tos",
    "--dns-digitalocean",
    "--dns-digitalocean-credentials",
    DO_CONFIG_PATH,
    "--email",
    email,
    "-d",
    `*.apps.${cluster_name}.${domain}`,
    "-d",
    `*.${cluster_name}.${domain}`,
    "-d",
    `*.${domain}`,
    "-d",
    `${domain}`,
  ];

  if (Deno.env.get("TEST")) cmd.push("--test-cert");

  const command = Deno.run({
    cmd,
    stdout: "piped",
  });

  const status = await command.status();

  const output = await command.output();

  console.log(new TextDecoder().decode(output));

  return status;
}

export async function updateTLSSecrets() {
  console.log(`!! Creating new tls secrets ...`);

  const sa_token = Deno.env.get("SA_TOKEN");
  const cluster_domain = Deno.env.get("CLUSTER_DOMAIN");
  const tls_secret_name = Deno.env.get("TLS_SECRET_NAME");

  const crt = new TextDecoder("utf-8").decode(
    await Deno.run({
      cmd: ["base64", "-w", "0", `/etc/letsencrypt/live/apps.${cluster_domain}/fullchain.pem`],
      stdout: "piped",
    }).output()
  );

  const key = new TextDecoder("utf-8").decode(
    await Deno.run({
      cmd: ["base64", "-w", "0", `/etc/letsencrypt/live/apps.${cluster_domain}/privkey.pem`],
      stdout: "piped",
    }).output()
  );

  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    type: "kubernetes.io/tls",
    metadata: {
      name: tls_secret_name,
      labels: {
        "created-via-automation": "true",
      },
    },
    data: {
      "tls.crt": crt,
      "tls.key": key,
    },
  };
  const namespaces = ["openshift-ingress", "openshift-config"];

  for (const namespace of namespaces) {
    const result = await fetch(`https://api.${cluster_domain}:6443/api/v1/namespaces/${namespace}/secrets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sa_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(secret),
    });

    console.log(
      `Result creating tls secret: '${tls_secret_name}' in namespace: '${namespace}' status: ${result.status}`
    );
  }
}

export async function updateIngress() {
  console.log("!! Updating the ingress controller defaultCert...");

  const sa_token = Deno.env.get("SA_TOKEN");
  const cluster_domain = Deno.env.get("CLUSTER_DOMAIN")!.trim();
  const tls_secret_name = Deno.env.get("TLS_SECRET_NAME");

  const patch = { spec: { defaultCertificate: { name: tls_secret_name } } };

  const result = await fetch(
    `https://api.${cluster_domain}:6443/apis/operator.openshift.io/v1/namespaces/openshift-ingress-operator/ingresscontrollers/default`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${sa_token}`,
        "Content-Type": "application/merge-patch+json",
      },
      body: JSON.stringify(patch),
    }
  );

  console.log(`Result patching default ingress controller status: ${result.status}`);
}

export async function updateAPI() {
  console.log("!! Updating API servingCerts...");

  const sa_token = Deno.env.get("SA_TOKEN");
  const cluster_domain = Deno.env.get("CLUSTER_DOMAIN")!.trim();
  const tls_secret_name = Deno.env.get("TLS_SECRET_NAME");

  const patch = {
    spec: {
      servingCerts: {
        namedCertificates: [{ names: [`api.${cluster_domain}`], servingCertificate: { name: tls_secret_name } }],
      },
    },
  };

  const result = await fetch(`https://api.${cluster_domain}:6443/apis/config.openshift.io/v1/apiservers/cluster`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${sa_token}`,
      "Content-Type": "application/merge-patch+json",
    },
    body: JSON.stringify(patch),
  });

  console.log(`Result patching api status: ${result.status}`);
}

export async function updateConsole() {
  console.log("!! Updating Console servingCertKeyPairSecret...");

  const sa_token = Deno.env.get("SA_TOKEN");
  const base_domain = Deno.env.get("BASE_DOMAIN")!.trim();
  const cluster_domain = Deno.env.get("CLUSTER_DOMAIN")!.trim();
  const tls_secret_name = Deno.env.get("TLS_SECRET_NAME");

  const patch = {
    spec: {
      componentRoutes: [
        {
          name: "console",
          namespace: "openshift-console",
          hostname: `origins.${base_domain}`,
          servingCertKeyPairSecret: {
            name: tls_secret_name,
          },
        },
      ],
    },
  };

  const result = await fetch(`https://api.${cluster_domain}:6443/apis/config.openshift.io/v1/ingresses/cluster`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${sa_token}`,
      "Content-Type": "application/merge-patch+json",
    },
    body: JSON.stringify(patch),
  });

  console.log(`Result patching api status: ${result.status}`);
}

export async function deleteOldCertificate() {
  const sa_token = Deno.env.get("SA_TOKEN");
  const cluster_domain = Deno.env.get("CLUSTER_DOMAIN")!.trim();

  const old_secret_name = Deno.env.get("OLD_CERTS")!;

  const namespaces = ["openshift-ingress", "openshift-config"];

  for (const namespace of namespaces) {
    const result = await fetch(
      `https://api.${cluster_domain}:6443/api/v1/namespaces/${namespace}/secrets/${old_secret_name}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${sa_token}` },
      }
    );

    console.log(
      `Result deleting tls secret: '${old_secret_name}' in namespace: '${namespace}' status: ${result.status}`
    );
  }
}

export function wait(ms = 2000) {
  console.log("waiting " + ms + "ms ...");
  return new Promise((resolve, _reject) => {
    setTimeout(() => resolve(true), ms);
  });
}
