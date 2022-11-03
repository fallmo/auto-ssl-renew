import { exec } from "https://deno.land/x/exec/mod.ts";

import { TLS_NAMESPACE, CTLR_NAMESPACE, TLS_SECRET_NAME, DO_CONFIG_PATH } from "./constants.ts";

export async function checkEnvironment() {
  console.log("!! Checking Environment Variables...");
  const varsNeeded = ["EMAIL", "CLUSTER_DOMAIN"];

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

export async function generateCertificates() {
  console.log("!! Generating Certificates...");
  const email = Deno.env.get("EMAIL")!.trim();
  const cluster_domain = Deno.env.get("CLUSTER_DOMAIN")!.trim();

  await exec(`certbot-3 certonly \ 
  --non-interactive --agree-tos ${Deno.env.get("TEST") ? "--test-cert" : ""}\
  --dns-digitalocean --dns-digitalocean-credentials ${DO_CONFIG_PATH} --dns-digitalocean-propagation-seconds 15 \
  --email ${email} \
  --domains "*.apps.${cluster_domain}"`);
}

export async function updateSecret() {
  console.log(`!! Updating the tls secret ...`);
  const cluster_domain = Deno.env.get("CLUSTER_DOMAIN")!.trim();

  const token_file = await Deno.readFile("/var/run/secrets/kubernetes.io/serviceaccount/token");
  const sa_token = new TextDecoder("utf-8").decode(token_file);

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
      name: TLS_SECRET_NAME,
      namespace: TLS_NAMESPACE,
      labels: {
        "created-via-automation": "true",
      },
    },
    data: {
      "tls.crt": crt,
      "tls.key": key,
    },
  };

  const checkExisting = await fetch(
    `https://api.${cluster_domain}:6443/api/v1/namespaces/${TLS_NAMESPACE}/secrets/${TLS_SECRET_NAME}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${sa_token}` },
    }
  );

  const update = checkExisting.status === 404 ? false : true;

  const result = await fetch(
    `https://api.${cluster_domain}:6443/api/v1/namespaces/${TLS_NAMESPACE}/secrets${
      update ? `/${TLS_SECRET_NAME}` : ""
    }`,
    {
      method: update ? "PUT" : "POST",
      headers: {
        Authorization: `Bearer ${sa_token}`,
        "Content-Type": update ? "application/merge-patch+json" : "application/json",
      },
      body: JSON.stringify(secret),
    }
  );

  console.log(`Result ${update ? "updating" : "creating"} tls secret: '${TLS_SECRET_NAME}' status: ${result.status}`);
}

export async function updateIngress() {
  console.log("!! Updating the ingress controller defaultCert...");

  const cluster_domain = Deno.env.get("CLUSTER_DOMAIN")!.trim();

  const token_file = await Deno.readFile("/var/run/secrets/kubernetes.io/serviceaccount/token");
  const sa_token = new TextDecoder("utf-8").decode(token_file);

  const patch = { spec: { defaultCertificate: { name: TLS_SECRET_NAME } } };

  const result = await fetch(
    `https://api.${cluster_domain}:6443/apis/operator.openshift.io/v1/namespaces/${CTLR_NAMESPACE}/ingresscontrollers/default`,
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

export function wait(ms = 2000) {
  console.log("waiting " + ms + "ms ...");
  return new Promise((resolve, _reject) => {
    setTimeout(() => resolve(true), ms);
  });
}
