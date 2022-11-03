import { checkEnvironment, generateCertificates, updateIngress, updateSecret, wait } from "./functions.ts";

console.log(`Mission Start...\n`);

await checkEnvironment();

await generateCertificates();

await wait();

await updateSecret();

await wait();

await updateIngress();

await wait();

console.log(`\nMission Complete...`);
