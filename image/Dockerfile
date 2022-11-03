FROM fedora:37

RUN yum update -y && yum install -y certbot.noarch python3-certbot-dns-digitalocean.noarch

COPY ./entrypoint .

RUN chmod 774 ./entrypoint

USER root

CMD ./entrypoint