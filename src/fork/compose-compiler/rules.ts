/**
 * Mirror compiler constants (W20, R3). PURE: no I/O, no clock, no randomness. Normative semantics = vault plan-W20 §3 (D-4, D-5) and ADR-009.
 * The env/label heuristics are KEY-name based (the dashboard never sees a value) and are defence in depth only: the isolation control is the
 * W21 egress firewall. A wrong classification makes a mirror fail its health gate (honest FAILED); it never makes it unsafe.
 */
export const MIRROR_COMPILER_VERSION = 1 as const;
export const PROJECT_RE = /^pbm-[a-z0-9][a-z0-9-]{0,58}$/;
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/;
export const ACCESS_NETWORK = "pbm_access";
/** = agent restore/docker_ops.rs:9-10 */
export const OWNER_LABELS = ["com.portabase.fork.restore_id", "com.portabase.fork.agent_id"] as const;

export type Disposition = "keep" | "transform" | "refuse";
/** EVERY key of RULES.service_keys_known (+ build, provider, extends); a unit test enforces completeness (D-3: fail closed). */
export const SERVICE_KEY_DISPOSITION: Record<string, Disposition> = {
    ...Object.fromEntries(
        ("annotations attach blkio_config cap_add cap_drop command configs cpu_count cpu_percent cpu_period cpu_quota cpu_shares cpus cpuset depends_on deploy domainname entrypoint expose group_add healthcheck hostname image init ipc mem_limit mem_reservation mem_swappiness memswap_limit pid pids_limit platform pull_policy read_only restart scale secrets security_opt shm_size stdin_open stop_grace_period stop_signal sysctls tmpfs tty ulimits user volumes working_dir")
            .split(" ")
            .map((k) => [k, "keep"]),
    ),
    ...Object.fromEntries(
        "container_name dns dns_opt dns_search environment external_links extra_hosts labels links logging mac_address network_mode networks ports profiles develop".split(" ").map((k) => [k, "transform"]),
    ),
    ...Object.fromEntries("devices env_file privileged use_api_socket build provider extends".split(" ").map((k) => [k, "refuse"])),
};

/** keys removed with a counts-only diff line (never values: extra_hosts / dns usually hold production IPs) */
export const REMOVED_KEYS = ["dns", "dns_opt", "dns_search", "extra_hosts", "external_links", "links", "logging", "mac_address", "profiles", "develop"] as const;

export const LABEL_DROP_PREFIXES = [
    "traefik.", "caddy", "com.centurylinklabs.watchtower.", "wud.", "diun.", "ofelia.", "chadburn.", "swarm.cronjob", "homepage.", "autoheal", "deunhealth.", "kuma.", "sablier.", "tsdproxy.", "com.docker.compose.", "com.portabase.fork.",
] as const;

/** ASCII-only lower-casing (non-ASCII look-alikes stay inert). */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const asciiUpper = (s: string) => s.replace(/[a-z]/g, (c) => c.toUpperCase());

/** true when a service label key is dropped from a mirror (proxy / updater / scheduler labels would act on production-shaped names). */
export function isDroppedLabel(key: string): boolean {
    const k = asciiLower(key);
    return LABEL_DROP_PREFIXES.some((p) => (p.endsWith(".") ? k.startsWith(p) : k === p || k.startsWith(`${p}.`) || k.startsWith(`${p}_`)));
}

export const SECRET_TOKENS = ["PASSWORD", "PASSWD", "PASS", "PWD", "SECRET", "TOKEN", "APIKEY", "API_KEY", "ACCESS_KEY", "ACCESSKEY", "PRIVATE_KEY", "PRIVATEKEY", "SALT", "PEPPER", "SIGNING_KEY", "ENCRYPTION_KEY", "CREDENTIAL", "CREDENTIALS", "AUTH_KEY", "LICENSE_KEY", "SECRET_KEY", "MASTER_KEY", "APP_KEY", "SECRET_KEY_BASE", "PGPASSWORD"] as const;
export const NON_SECRET_SUFFIX = ["FILE", "PATH", "DIR", "ENABLED", "ENABLE", "DISABLED", "LENGTH", "LEN", "MIN", "MAX", "TTL", "EXPIRY", "EXPIRES", "EXPIRATION", "TIMEOUT", "POLICY", "ALGORITHM", "ALG", "TYPE", "MODE", "HEADER", "NAME", "USER", "USERNAME", "URL", "URI", "HOST", "PORT", "ROUNDS", "COST", "ITERATIONS", "LIFETIME", "AGE", "COUNT", "REQUIRED", "RESET"] as const;
export const SIDE_EFFECT_TOKENS = ["SMTP", "MAIL", "EMAIL", "MAILER", "SENDGRID", "MAILGUN", "POSTMARK", "SES", "SPARKPOST", "MANDRILL", "SLACK", "DISCORD", "TELEGRAM", "PUSHOVER", "NTFY", "GOTIFY", "APPRISE", "TWILIO", "VONAGE", "NEXMO", "STRIPE", "PAYPAL", "BRAINTREE", "MOLLIE", "ADYEN", "SQUARE", "PADDLE", "SENTRY", "S3", "AWS", "MINIO", "R2", "B2", "GCS", "AZURE"] as const;
export const ENDPOINT_SUFFIX = ["HOST", "HOSTNAME", "SERVER", "URL", "URI", "DSN", "ENDPOINT", "ADDRESS", "ADDR"] as const;
export const DB_ENGINES = {postgresql: ["postgres", "postgis", "timescaledb"], mysql: ["mysql", "mariadb"]} as const;

/** shell / process names: never secrets */
const ALWAYS_KEEP = new Set(["PWD", "OLDPWD", "PATH", "HOME", "HOSTNAME", "TZ", "LANG"]);

/** `tokens` (which may contain `_`) occurs as a contiguous run of `seg`. */
function hasRun(seg: string[], token: string): boolean {
    const t = token.split("_");
    for (let i = 0; i + t.length <= seg.length; i++) if (t.every((x, j) => seg[i + j] === x)) return true;
    return false;
}

export type EnvClass = "rotate" | "disable" | "keep";
/** D-5 precedence: secret (rotate) unless the last segment is a non-secret suffix; then side-effect endpoint / webhook / DOCKER_HOST (disable); else keep. */
export function classifyEnvKey(key: string): EnvClass {
    const up = asciiUpper(key);
    if (ALWAYS_KEEP.has(up)) return "keep";
    const seg = up.split(/[_.-]/);
    const last = seg[seg.length - 1] ?? "";
    if (SECRET_TOKENS.some((t) => hasRun(seg, t)) && !(NON_SECRET_SUFFIX as readonly string[]).includes(last)) return "rotate";
    if (up === "DOCKER_HOST") return "disable";
    if (seg.includes("WEBHOOK") || seg.includes("HOOK")) return "disable";
    if (seg.some((s) => (SIDE_EFFECT_TOKENS as readonly string[]).includes(s)) && (ENDPOINT_SUFFIX as readonly string[]).includes(last)) return "disable";
    return "keep";
}
