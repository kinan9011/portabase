# W21 lab "runner VM": docker-in-docker + nftables. LOCAL image only (tag pbr-w21-runner:lab), never pushed. See ADR-008 §Lab emulation.
# The base is pinned by digest (recorded in Implementation/evidence-W21/images.txt); the real VM runbook uses docker-ce + the same two config files.
FROM docker:29-dind@sha256:7bf70dcb85c822e3fa6f2d332143e474b99147b9d7b39102b0cfe8b04a7dd61b
RUN apk add --no-cache nftables tcpdump
COPY daemon.lab.json /etc/docker/daemon.json
COPY nftables.conf runner-dns.lab.nft runner-dns.vm.nft /etc/pbm-template/
