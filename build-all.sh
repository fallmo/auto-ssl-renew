deno compile --allow-run  --allow-read --allow-env --allow-net --unsafely-ignore-certificate-errors --output image/entrypoint src/index.ts

podman build -t quay.io/mohamedf0/autocert:latest image

podman push quay.io/mohamedf0/autocert:latest