# portabase-recover convenience image (W14b, NOT an R1 gate). The bare-host script is the supported path. Run it BY DIGEST (never by tag), kit mounted read-only:
#   docker run --rm -it -v /path/to/kit:/kit:ro -v /srv/portabase-restore:/srv/portabase-restore -v /var/run/docker.sock:/var/run/docker.sock <image@sha256:digest> plan --kit /kit/kit.pbkit ...
# Build (repo root):  docker build -f scripts/fork/recover/Dockerfile -t portabase-recover:local .  ->  publish, then record the DIGEST for the kit.
FROM docker:27-cli
RUN apk add --no-cache bash openssl jq restic rclone python3 py3-cryptography py3-yaml coreutils tar findutils
COPY scripts/fork/recover/portabase-recover scripts/fork/recover/decrypt-archive scripts/fork/recover/kit-tool /opt/portabase-recover/
COPY src/fork/policy/compose-deny.json /opt/portabase-recover/compose-deny.json
RUN chmod 0555 /opt/portabase-recover/*
ENTRYPOINT ["/opt/portabase-recover/portabase-recover"]
