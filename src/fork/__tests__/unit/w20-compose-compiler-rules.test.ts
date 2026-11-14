import {readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {SERVICE_KEY_DISPOSITION, classifyEnvKey, isDroppedLabel} from "@/fork/compose-compiler/rules";
import {RULES} from "@/fork/policy/rules";

describe("mirror compiler rules (W20 D-3, D-5)", () => {
    it("classifies every key of RULES.service_keys_known (fail closed on a future rule-file key)", () => {
        for (const k of RULES.service_keys_known) expect(SERVICE_KEY_DISPOSITION[k], k).toBeDefined();
        for (const k of ["build", "provider", "extends"]) expect(SERVICE_KEY_DISPOSITION[k]).toBe("refuse");
    });

    it("has no key outside the rule file except the three mirror-only refusals", () => {
        const extra = Object.keys(SERVICE_KEY_DISPOSITION).filter((k) => !RULES.service_keys_known.includes(k));
        expect(extra.sort()).toEqual(["build", "extends", "provider"]);
    });

    it("dispositions match the plan table", () => {
        expect(SERVICE_KEY_DISPOSITION.ports).toBe("transform");
        expect(SERVICE_KEY_DISPOSITION.environment).toBe("transform");
        expect(SERVICE_KEY_DISPOSITION.healthcheck).toBe("keep");
        expect(SERVICE_KEY_DISPOSITION.privileged).toBe("refuse");
        expect(SERVICE_KEY_DISPOSITION.devices).toBe("refuse");
    });

    type Want = "rotate" | "disable" | "keep";
    const of = (want: Want, keys: string[]): [string, Want][] => keys.map((k) => [k, want]);
    const cases: [string, Want][] = [
        ...of("rotate", ["POSTGRES_PASSWORD", "DB_PASS", "MYSQL_PWD", "PGPASSWORD", "JWT_SECRET", "NEXTAUTH_SECRET", "STRIPE_SECRET_KEY", "APP_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "SECRET_KEY_BASE", "api.key", "db-password", "MASTER_KEY", "SMTP_PASSWORD", "WEBHOOK_SECRET"]),
        ...of("keep", ["PASSWORD_MIN_LENGTH", "POSTGRES_PASSWORD_FILE", "TOKEN_URL", "SECRET_KEY_ALGORITHM", "SMTP_PORT", "MAIL_FROM", "STRIPE_PUBLISHABLE_KEY", "APP_GREETING", "POSTGRES_USER", "PWD", "OLDPWD", "PATH", "HOME", "HOSTNAME", "TZ", "LANG", "REDIS_URL", "DATABASE_URL"]),
        ...of("disable", ["SMTP_HOST", "MAIL_SERVER", "MAILER_DSN", "SENTRY_DSN", "S3_ENDPOINT", "SLACK_WEBHOOK", "WEBHOOK_URL", "DOCKER_HOST", "SES_ENDPOINT"]),
    ];
    it.each(cases)("classifyEnvKey(%s) = %s", (k, want) => {
        expect(classifyEnvKey(k)).toBe(want);
    });

    it("has at least 40 classifier cases", () => expect(cases.length).toBeGreaterThanOrEqual(40));

    it("is ASCII case-insensitive and ignores non-ASCII look-alikes", () => {
        expect(classifyEnvKey("postgres_password")).toBe("rotate");
        expect(classifyEnvKey("PASSWОRD")).toBe("keep"); // Cyrillic О is inert
    });

    it("drops proxy / updater / scheduler labels, keeps others", () => {
        for (const k of ["traefik.enable", "Traefik.http.routers.x", "caddy", "caddy.reverse_proxy", "caddy_0", "com.centurylinklabs.watchtower.enable", "wud.watch", "diun.enable", "ofelia.job-exec.x", "swarm.cronjob.enable", "homepage.name", "autoheal", "com.docker.compose.project", "com.portabase.fork.restore_id"]) expect(isDroppedLabel(k), k).toBe(true);
        for (const k of ["forklab.role", "app.kubernetes.io/name", "caddyish", "traefіk.enable", "autohealer"]) expect(isDroppedLabel(k), k).toBe(false);
    });
});

describe("FORK.md documents every service key (W20 D-10)", () => {
    const md = readFileSync(path.join(process.cwd(), "FORK.md"), "utf8");
    const i = md.indexOf("## Mirror compiler (W20");
    const end = md.indexOf("\n## ", i + 5);
    const section = i < 0 ? "" : md.slice(i, end < 0 ? undefined : end);
    it("has the section and mentions every disposition key + top-level key", () => {
        expect(i).toBeGreaterThan(-1);
        for (const k of [...Object.keys(SERVICE_KEY_DISPOSITION), "name", "networks", "volumes", "secrets", "configs", "x-*"]) expect(section.includes(`\`${k}\``), k).toBe(true);
    });
});
