import {
  checkEnvironment,
  setAdditionalVars,
  generateCertificates,
  updateTLSSecrets,
  updateIngress,
  updateAPI,
  wait,
  deleteOldCertificate,
} from "./functions.ts";

console.log(`Mission Start...\n`);

await checkEnvironment();

await setAdditionalVars();

await wait();

const output = await generateCertificates();

if (!output.success) Deno.exit(1);

await wait();

await updateTLSSecrets();

await wait();

await updateIngress();

await updateAPI();

await deleteOldCertificate();

await wait();

console.log(`\nMission Complete...`);
