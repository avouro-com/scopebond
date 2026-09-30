// A local mirror of the closed `network`, `cloudflare_resource` and `database` operation
// variants (their required and optional fields and cross-field rules), so the tests can prove
// an operation is exactly the closed shape and nothing more. The observation schema itself
// only fixes the envelope.
const ID = (v) => typeof v === "string" && v.length >= 1 && v.length <= 200;
const HEX64 = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const DIGEST = (v) => typeof v === "string" && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(v);
const oneOf = (...values) => (v) => values.includes(v);
const VIS = oneOf("private", "public", "unknown");

const COMMON = {
  resource_id: ID, environment_class: oneOf("development", "staging", "production", "unknown"),
  reference_set_version: ID, request_digest: HEX64, digest_key_generation: ID,
};

const CLOUDFLARE_VERBS = {
  worker: ["create", "update", "delete"], pages_project: ["create", "update", "delete"], pages_deployment: ["create", "delete"],
  d1_database: ["create", "update", "delete"], r2_bucket: ["create", "delete", "set_visibility"], r2_object: ["write", "delete"],
  dns_record: ["create", "update", "delete"],
};

const VARIANTS = {
  network: {
    req: { scheme: oneOf("http", "https"), host: (v) => typeof v === "string" && v.length >= 1 && v.length <= 253, port: (v) => Number.isInteger(v) && v >= 1 && v <= 65535,
      method: oneOf("GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"), net_operation: oneOf("read", "write", "upload") },
    opt: { destination_approval_ref: ID, redirect_binding: ID, source_classified_id: ID },
    refine: (o) => {
      const host = String(o.host);
      if (host !== host.toLowerCase() || /[^a-z0-9.\-]/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..")) return "host";
      if (o.net_operation === "read" && !["GET", "HEAD", "OPTIONS"].includes(o.method)) return "read method";
      if (o.net_operation === "upload" && !["POST", "PUT", "PATCH"].includes(o.method)) return "upload method";
      return null;
    },
  },
  cloudflare_resource: {
    req: { verb: oneOf("create", "update", "write", "delete", "set_visibility"), resource_kind: oneOf(...Object.keys(CLOUDFLARE_VERBS)), account_id: ID },
    opt: { environment_binding: ID, artifact_digest: DIGEST, visibility_before: VIS, visibility_after: VIS, dns_record_type: ID, zone_id: ID, record_id: ID },
    refine: (o) => {
      if (!CLOUDFLARE_VERBS[o.resource_kind]?.includes(o.verb)) return "verb for kind";
      if (o.verb === "set_visibility" && !("visibility_before" in o && "visibility_after" in o)) return "visibility";
      if (o.verb !== "set_visibility" && ("visibility_before" in o || "visibility_after" in o)) return "visibility only for set_visibility";
      if (o.resource_kind === "dns_record" && !("dns_record_type" in o && "zone_id" in o)) return "dns";
      if (o.resource_kind !== "dns_record" && ("dns_record_type" in o || "zone_id" in o || "record_id" in o)) return "dns fields";
      return null;
    },
  },
  database: {
    req: { provider: ID, verb: oneOf("read", "insert", "update", "delete", "delete_all", "create", "alter", "drop", "migrate"), predicate_class: oneOf("bounded", "all", "not_applicable"),
      database_id: ID, reviewed_destructive: (v) => typeof v === "boolean" },
    opt: { migration_digest: HEX64 },
    refine: (o) => {
      if (o.verb === "migrate" && !("migration_digest" in o)) return "migrate digest";
      if (o.verb === "delete_all" && o.predicate_class !== "all") return "delete_all all";
      if ((o.verb === "update" || o.verb === "delete") && o.predicate_class === "not_applicable") return "predicate";
      return null;
    },
  },
};

/** null when `op` is exactly a closed network, cloudflare_resource or database operation; otherwise a reason. */
export function operationProblem(op) {
  if (!op || typeof op !== "object") return "not an object";
  const variant = VARIANTS[op.type];
  if (!variant) return `unknown type ${op.type}`;
  const { type, ...rest } = op;
  const shape = { ...COMMON, ...variant.req };
  // Optional on every variant: the hash the dispatch guard consumes an approval with.
  if ("approval_request_hash" in rest && !HEX64(rest.approval_request_hash)) return "field approval_request_hash invalid";
  for (const [key, check] of Object.entries(shape)) if (!(key in rest) || !check(rest[key])) return `field ${key} invalid`;
  for (const [key, value] of Object.entries(rest)) {
    if (key in shape || key === "approval_request_hash") continue;
    if (!(key in variant.opt)) return `unknown key ${key}`;
    if (!variant.opt[key](value)) return `field ${key} invalid`;
  }
  return variant.refine(rest);
}
