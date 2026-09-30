import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { hashPassword, validatePasswordInput } from "@myskills-app/auth";

interface BootstrapInput { email: string; password: string }
interface BootstrapResult { outcome: "created" | "already-initialized" }
const markerKey = "owner-bootstrap";
const instanceScope = "00000000-0000-0000-0000-000000000000";

/** Explicit first use only. This command cannot reset or recover an account. */
export async function bootstrapOwner(pool: Pick<pg.Pool, "connect">, input: BootstrapInput): Promise<BootstrapResult> {
  const email = input.email?.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[!-~]+$/.test(email) || !/^[^@\s]{1,64}@[^@\s.]+(?:\.[^@\s.]+)+$/.test(email)) {
    throw new Error("A valid owner email is required.");
  }
  validatePasswordInput(input.password);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '30s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    // Use the migrator's lock too: its table catalogue must not change during
    // the fresh-instance check. The transaction releases both locks on failure.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('myskills-schema-migrations-v1'))");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('myskills-first-owner-v1'))");
    const tables = (await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    if (!["users", "roles", "role_assignments", "password_credentials", "instance_settings", "schema_migrations"].every((name) => tables.some((t) => t.tablename === name))) {
      throw new Error("Apply the release migrations before bootstrap.");
    }
    // First use has no concurrent writes. These locks also fence registration
    // or imports that started before the caller observed an empty registry.
    await client.query(`LOCK TABLE ${tables.map((t) => `public.${identifier(t.tablename)}`).join(",")} IN SHARE ROW EXCLUSIVE MODE`);
    const marker = (await client.query<{ value: { initialOwnerUserId?: string } }>("SELECT value FROM instance_settings WHERE key=$1", [markerKey])).rows[0];
    if (marker) {
      const ownerId = marker.value?.initialOwnerUserId;
      if (typeof ownerId !== "string" || !/^[a-f0-9-]{36}$/i.test(ownerId)) throw new Error("Bootstrap marker requires operator inspection.");
      const owner = (await client.query("SELECT 1 FROM users u JOIN password_credentials p ON p.user_id=u.id JOIN role_assignments r ON r.user_id=u.id WHERE u.id=$1 AND u.normalized_email=$2 AND u.status='active' AND r.role='owner' AND r.scope_type='instance' AND r.scope_id=$3", [ownerId, email, instanceScope])).rows[0];
      if (!owner) throw new Error("Bootstrap cannot recover or change an initialized owner.");
      await client.query("COMMIT");
      return { outcome: "already-initialized" };
    }
    for (const { tablename } of tables) {
      if (["schema_migrations", "instance_settings", "github_app_config"].includes(tablename)) continue;
      if ((await client.query(`SELECT 1 FROM public.${identifier(tablename)} LIMIT 1`)).rowCount) {
        throw new Error("Bootstrap requires an unused registry; existing data is preserved.");
      }
    }
    const settings = await client.query("SELECT key,value FROM instance_settings");
    for (const { key, value } of settings.rows) {
      const pristine = key === "instance_id" ? typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value)
        : key === "library" ? JSON.stringify(value) === JSON.stringify({ privateSelfReviewEnabled: false })
          : key === "sharing" ? ["publicVisibilityEnabled", "authenticatedVisibilityEnabled", "teamsEnabled", "teamVisibilityEnabled", "userVisibilityEnabled"].every((k) => value?.[k] === true) && Object.keys(value).length === 5
            : false;
      if (!pristine) throw new Error("Bootstrap requires unchanged migration defaults.");
    }
    if (tables.some((t) => t.tablename === "github_app_config") && (await client.query("SELECT 1 FROM github_app_config WHERE enabled OR app_id<>'' OR client_id<>'' OR client_secret_ciphertext IS NOT NULL OR private_key_ciphertext IS NOT NULL OR installation_id IS NOT NULL OR installation_enabled OR generation<>1 OR installation_ciphertext IS NOT NULL OR installation_expires_at IS NOT NULL OR installation_invalid OR last_checked_at IS NOT NULL OR last_error_code IS NOT NULL LIMIT 1")).rowCount) {
      throw new Error("Bootstrap requires an unused GitHub configuration.");
    }
    const passwordHash = await hashPassword(input.password);
    await client.query("INSERT INTO roles(name,description) SELECT value::role_name,value || ' role' FROM unnest($1::text[]) AS value", [["owner", "admin", "maintainer", "author", "user"]]);
    const ownerId = (await client.query("INSERT INTO users(email,normalized_email,name,status,email_verified_at) VALUES($1,$1,'Instance Owner','active',now()) RETURNING id", [email])).rows[0].id;
    await client.query("INSERT INTO password_credentials(user_id,password_hash) VALUES($1,$2)", [ownerId, passwordHash]);
    await client.query("INSERT INTO role_assignments(user_id,role,scope_type,scope_id) VALUES($1,'owner','instance',$2)", [ownerId, instanceScope]);
    await client.query("INSERT INTO instance_settings(key,value) VALUES ('registration','{\"mode\":\"closed\"}'::jsonb),($1,$2::jsonb)", [markerKey, JSON.stringify({ initialOwnerUserId: ownerId })]);
    await client.query("INSERT INTO audit_events(actor_user_id,action,decision,resource_type,resource_id) VALUES($1,'instance.owner.bootstrap','allow','user',$1)", [ownerId]);
    await client.query("COMMIT");
    return { outcome: "created" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function identifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entrypoint === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    console.log("Usage: node apps/api/dist/db/bootstrap-owner.js (protected SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD environment)");
  } else {
    let pool: pg.Pool | undefined;
    try {
      if (process.argv.length !== 2 || !process.env.DATABASE_URL || !process.env.SEED_OWNER_EMAIL || !process.env.SEED_OWNER_PASSWORD) throw new Error("Protected bootstrap configuration is required.");
      if (process.env.SEED_OWNER_EMAIL.trim().toLowerCase() === "owner@example.com" || process.env.SEED_OWNER_PASSWORD === "change-me-now-please") throw new Error("Example bootstrap credentials are refused.");
      pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
      console.log(JSON.stringify(await bootstrapOwner(pool, { email: process.env.SEED_OWNER_EMAIL, password: process.env.SEED_OWNER_PASSWORD })));
    } catch {
      console.error(JSON.stringify({ passed: false, phase: "owner-bootstrap", guidance: "Use a fresh migrated registry and protected owner credentials; account recovery requires the existing recovery flow." }));
      process.exitCode = 1;
    } finally {
      await pool?.end();
    }
  }
}
