import {blankPolicyView} from "@/fork/restore-tasks/view";

/** Lab-shaped rendered compose (modelled on the real `docker compose config --format json` of dev/fork-lab/demo-stack, Compose v5.4.0). Test data only. */
export const WS = "/srv/mirrors/pbm-lab";
export const PROJECT = "pbm-lab";
export const CANARY = "W20_CANARY_7f3a9c51d2e84b6a";
export const PG_PW = `${CANARY}_pgpw`;
export const IMG = "postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b";
export const CLEAN_RAW = {refused: false, violations: [], reason: null} as const;
export const ACCESS = {service: "web", target: 8080, host_port: 18099} as const;

export function labFull(): Record<string, unknown> {
    return {
        name: "forklab-demo",
        services: {
            db: {
                image: IMG,
                environment: {POSTGRES_PASSWORD: PG_PW, POSTGRES_USER: "app", POSTGRES_DB: "app", APP_GREETING: "hello", PASSTHRU: null},
                healthcheck: {test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"], interval: "3s", timeout: "3s", retries: 20},
                labels: {"forklab.role": "database", "com.portabase.fork.restore_id": "r1", "com.portabase.fork.agent_id": "a1"},
                networks: {internal: {aliases: ["demo-db"]}},
                restart: "unless-stopped",
                volumes: [{type: "volume", source: "pgdata", target: "/var/lib/postgresql/data", volume: {}}],
            },
            web: {
                image: IMG,
                container_name: "lab-web",
                command: ["sh", "-c", `echo ${CANARY}`],
                depends_on: {db: {condition: "service_healthy", required: true}},
                entrypoint: ["/bin/sh", "/app/serve.sh"],
                environment: {POSTGRES_PASSWORD: PG_PW, DATABASE_URL: `postgres://app:${PG_PW}@demo-db:5432/app`, SMTP_HOST: "smtp.prod.example", APP_GREETING: "hello"},
                extra_hosts: {"db.prod": "10.9.8.7"},
                labels: {"forklab.role": "app", "traefik.enable": "true", "com.portabase.fork.restore_id": "r1", "com.portabase.fork.agent_id": "a1", canary: CANARY},
                networks: {internal: null, lab_proxy: null},
                ports: [{mode: "ingress", host_ip: "127.0.0.1", target: 8080, published: "18080", protocol: "tcp"}],
                restart: "unless-stopped",
                volumes: [
                    {type: "bind", source: `${WS}/web/serve.sh`, target: "/app/serve.sh", read_only: true, bind: {create_host_path: true}},
                    {type: "volume", source: "appdata", target: "/appdata", volume: {}},
                ],
            },
        },
        networks: {internal: {name: "forklab-demo_internal", internal: true}, lab_proxy: {name: "lab_proxy", external: true}},
        volumes: {pgdata: {name: "forklab-demo_pgdata"}, appdata: {name: "forklab-demo_appdata"}},
    };
}
export const labView = (): Record<string, unknown> => blankPolicyView(labFull()) as Record<string, unknown>;
export const labViewJson = (): string => JSON.stringify(labView());
