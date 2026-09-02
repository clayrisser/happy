// deploy/integration-tests/shared-sessions.mjs — the client half of
// shared-sessions.bats (DROVE-388).
//
// Runs the happy fork's OWN CLI code against a throwaway relay, so what is
// proven is the real path and not a re-implementation of it: the CLI's auth
// challenge, the CLI's ApiClient session create (which wraps the session key
// the way a paired CLI does), and the CLI's encrypt/decrypt. The "owner's
// app" and the "guest's app" halves (unwrapping a session key with a box
// private key, re-wrapping it for someone else) are the same tweetnacl calls
// the app makes, written out here so the layout is visible.
//
// Executed by tsx from the fork's happy-cli package directory so the `@/`
// path alias inside that code resolves.
//
// Environment: FORK_DIR (the fork checkout), HAPPY_HOME_DIR (a throwaway home
// under the test's state dir; NEVER ~/.happy), HAPPY_SERVER_URL (the relay),
// SHARED_SESSIONS_STATE (where the fixture keys and session records live).
// Every key here is minted by `keygen` and thrown away with the state dir.
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const fork = process.env.FORK_DIR;
if (!fork) {
  console.error("shared-sessions: FORK_DIR is required");
  process.exit(2);
}
const home = process.env.HAPPY_HOME_DIR || "";
if (!home.includes("shared-sessions")) {
  // The CLI's configuration module creates HAPPY_HOME_DIR on import. Refuse
  // anything that does not look like the test's own dir rather than risk
  // touching a real credential store.
  console.error(`shared-sessions: HAPPY_HOME_DIR must be the test's own home, got ${home || "(unset)"}`);
  process.exit(2);
}
const stateDir = process.env.SHARED_SESSIONS_STATE;
if (!stateDir || !stateDir.includes("shared-sessions")) {
  console.error(`shared-sessions: SHARED_SESSIONS_STATE must be the test's own dir, got ${stateDir || "(unset)"}`);
  process.exit(2);
}
const cli = `${fork}/packages/happy-cli/src`;
const requireFromCli = createRequire(`${cli}/api/apiSession.ts`);
const nacl = requireFromCli("tweetnacl");

const enc = await import(`${cli}/api/encryption.ts`);
const { configuration } = await import(`${cli}/configuration.ts`);
const serverUrl = configuration.serverUrl;

const [cmd, ...args] = process.argv.slice(2);

// --- state ---------------------------------------------------------------

function statePath(name) {
  return path.join(stateDir, `${name}.json`);
}
function readState(name) {
  return JSON.parse(fs.readFileSync(statePath(name), "utf8"));
}
function writeState(name, value) {
  fs.writeFileSync(statePath(name), JSON.stringify(value, null, 2));
}
function b64(bytes) {
  return enc.encodeBase64(bytes);
}
function unb64(s) {
  return enc.decodeBase64(s);
}
function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}
function out(value) {
  console.log(JSON.stringify(value));
}

// --- http -----------------------------------------------------------------

async function http(who, method, route, body) {
  const account = readState(who);
  const res = await fetch(`${serverUrl}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${account.token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

// --- keys ------------------------------------------------------------------
//
// Layout of a wrapped key, the same on both clients:
//   0x00 | ephemeral public key (32) | nonce (24) | crypto_box(data key)
// libsodiumEncryptForPublicKey (CLI) writes it; the app's decryptEncryptionKey
// opens it. unwrap() below is that open, with tweetnacl.

function unwrap(wrappedB64, boxSecretKey) {
  const bundle = unb64(wrappedB64);
  if (bundle[0] !== 0) throw new Error(`wrapped key version byte is ${bundle[0]}, expected 0`);
  const ephemeralPublicKey = bundle.slice(1, 33);
  const nonce = bundle.slice(33, 57);
  const box = bundle.slice(57);
  const opened = nacl.box.open(box, nonce, ephemeralPublicKey, boxSecretKey);
  if (!opened) throw new Error("wrapped key did not open with this box secret key");
  return new Uint8Array(opened);
}

function wrap(dataKey, boxPublicKey) {
  const wrapped = enc.libsodiumEncryptForPublicKey(dataKey, boxPublicKey);
  const result = new Uint8Array(wrapped.length + 1);
  result.set([0], 0);
  result.set(wrapped, 1);
  return result;
}

// The session key a caller can open, from its own /v1/sessions row: the
// owner's wrap for the owner, the grant's re-wrap for a grantee. This is
// exactly what the app does on every sync.
async function sessionKeyFor(who, sessionId) {
  const account = readState(who);
  const list = await http(who, "GET", "/v1/sessions");
  if (list.status !== 200) throw new Error(`list as ${who}: ${list.status}`);
  const row = list.body.sessions.find((s) => s.id === sessionId);
  if (!row) throw new Error(`session ${sessionId} is not in ${who}'s list`);
  if (!row.dataEncryptionKey) throw new Error(`session ${sessionId} has no dataEncryptionKey for ${who}`);
  return unwrap(row.dataEncryptionKey, unb64(account.boxSecretKey));
}

// --- sockets ---------------------------------------------------------------

function withTimeout(promise, ms, what) {
  // The timer is cleared either way: left running it keeps the process alive
  // for the full window after the answer is already printed.
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function connect(auth) {
  const { io } = requireFromCli("socket.io-client");
  const socket = io(serverUrl, {
    auth,
    path: "/v1/updates",
    transports: ["websocket"],
    reconnection: false,
  });
  const connected = new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (e) => reject(new Error(`connect_error (${auth.clientType}): ${e.message}`)));
  });
  return withTimeout(connected, 15000, `${auth.clientType} socket connect`);
}

// Resolves true if a new-message update for `sessionId` arrives within
// `waitMs`, false otherwise. Factual either way; the caller decides which
// outcome the test expects.
function heardNewMessage(socket, sessionId, waitMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), waitMs);
    socket.on("update", (update) => {
      if (update?.body?.t === "new-message" && update.body.sid === sessionId) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}

function fixtureContent(fixture) {
  return {
    role: "agent",
    content: { type: "output", data: { type: "text", text: `shared sessions fixture ${fixture}` } },
  };
}

// --- commands --------------------------------------------------------------

switch (cmd) {
  case "keygen": {
    // Two accounts. Each has a signing seed (what /v1/auth proves) and a box
    // keypair (what a session key is wrapped to). In the real app the box
    // pair is derived from the master secret; here both are random fixtures.
    for (const who of ["owner", "guest"]) {
      const secret = enc.getRandomBytes(32);
      const box = nacl.box.keyPair();
      writeState(who, {
        secret: b64(secret),
        boxPublicKey: b64(box.publicKey),
        boxSecretKey: b64(box.secretKey),
      });
    }
    const owner = readState("owner");
    const signPublicKey = nacl.sign.keyPair.fromSeed(unb64(owner.secret)).publicKey;
    out({ ownerSignPublicKeyHex: hex(signPublicKey), stateDir, home: configuration.happyHomeDir, serverUrl });
    break;
  }
  case "auth": {
    const [who] = args;
    const { authGetToken } = await import(`${cli}/api/auth.ts`);
    const account = readState(who);
    const token = await authGetToken(unb64(account.secret));
    writeState(who, { ...account, token });
    const profile = await http(who, "GET", "/v1/account/profile");
    if (profile.status !== 200) throw new Error(`profile as ${who}: ${profile.status}`);
    writeState(who, { ...readState(who), accountId: profile.body.id });
    out({ who, id: profile.body.id, kind: profile.body.kind, contentPublicKey: profile.body.contentPublicKey });
    break;
  }
  case "register-key": {
    const [who] = args;
    const account = readState(who);
    out(await http(who, "POST", "/v1/account/content-key", { contentPublicKey: account.boxPublicKey }));
    break;
  }
  case "http": {
    const [who, method, route, body] = args;
    out(await http(who, method, route, body === undefined ? undefined : JSON.parse(body)));
    break;
  }
  case "socket-connect": {
    // Reports whether a socket of this type is accepted for this account.
    const [who, clientType, sessionId] = args;
    const account = readState(who);
    try {
      const socket = await connect({
        token: account.token,
        clientType,
        sessionId,
        machineId: clientType === "machine-scoped" ? "shared-sessions-fixture-machine" : undefined,
        happyClient: `shared-sessions/${who}`,
      });
      socket.close();
      out({ connected: true });
    } catch (error) {
      out({ connected: false, error: error.message });
    }
    break;
  }
  case "create-session": {
    // The CLI's own ApiClient. `dataKey` is what a QR-paired CLI does: mint a
    // session key, wrap it to the account's box public key. `legacy` is the
    // pre-dataKey CLI: everything under the master secret, no session key.
    // The fourth word is the kind (DROVE-388, decision 0c): `managed` or
    // `private` is the CLI's --managed / --private; nothing is the default
    // resolution (this machine's settings.json, then the account's profile).
    // An explicit `managed` on a relay that cannot manage is the one-line
    // failure the CLI gives, printed and exit 1.
    const [who, variant, name, kind] = args;
    const { ApiClient } = await import(`${cli}/api/api.ts`);
    const account = readState(who);
    const credential = variant === "legacy"
      ? { token: account.token, encryption: { type: "legacy", secret: unb64(account.secret) } }
      : { token: account.token, encryption: { type: "dataKey", publicKey: unb64(account.boxPublicKey), machineKey: enc.getRandomBytes(32) } };
    const client = await ApiClient.create(credential);
    let session;
    try {
      session = await client.getOrCreateSession({
        // Session.tag is kept in the clear by the server; an opaque id, as the
        // CLI uses.
        tag: `shared-sessions-${name}-${randomUUID()}`,
        metadata: { path: `/tmp/shared-sessions/${name}`, host: "shared-sessions-test", name: `shared ${name}`, version: configuration.currentCliVersion },
        state: null,
        managed: kind === "managed" ? true : kind === "private" ? false : undefined,
      });
    } catch (error) {
      console.error(`shared-sessions: ${error.message}`);
      process.exit(1);
    }
    if (!session) throw new Error("getOrCreateSession returned null");
    writeState(`session-${name}`, {
      id: session.id,
      encryptionKey: b64(session.encryptionKey),
      encryptionVariant: session.encryptionVariant,
    });
    out({ name, id: session.id, variant: session.encryptionVariant });
    break;
  }
  case "unwrap-and-rewrap": {
    // The owner's app: open the session's wrapped key with its own box
    // secret key (positive control: it is the key the CLI minted), re-wrap
    // it to the guest's box public key. The server sees only the result.
    const [name, from, to] = args;
    const session = readState(`session-${name}`);
    const dataKey = await sessionKeyFor(from, session.id);
    if (hex(dataKey) !== hex(unb64(session.encryptionKey))) {
      throw new Error("the unwrapped key is not the key the CLI minted");
    }
    const grantee = readState(to);
    const wrapped = wrap(dataKey, unb64(grantee.boxPublicKey));
    writeState(`wrapped-${name}-${to}`, { wrappedKey: b64(wrapped) });
    out({ name, unwrappedMatchesMinted: true, wrappedKey: b64(wrapped), wrappedKeyHex: hex(wrapped), dataKeyHex: hex(dataKey) });
    break;
  }
  case "grant": {
    const [owner, name, guest, role, by = "key"] = args;
    const session = readState(`session-${name}`);
    const grantee = readState(guest);
    const wrappedFile = statePath(`wrapped-${name}-${guest}`);
    // A legacy session never got a re-wrap (there is no key to wrap), so
    // send a correctly shaped placeholder: the server must refuse on the
    // session, not on the shape.
    const wrappedKey = fs.existsSync(wrappedFile)
      ? readState(`wrapped-${name}-${guest}`).wrappedKey
      : b64(wrap(enc.getRandomBytes(32), unb64(grantee.boxPublicKey)));
    const target = by === "id"
      ? { granteeAccountId: grantee.accountId }
      : { granteeContentPublicKey: grantee.boxPublicKey };
    out(await http(owner, "POST", `/v1/sessions/${session.id}/grants`, { ...target, wrappedKey, role }));
    break;
  }
  case "grants": {
    const [owner, name] = args;
    const session = readState(`session-${name}`);
    out(await http(owner, "GET", `/v1/sessions/${session.id}/grants`));
    break;
  }
  case "revoke": {
    const [owner, name, guest] = args;
    const session = readState(`session-${name}`);
    const grantee = readState(guest);
    out(await http(owner, "DELETE", `/v1/sessions/${session.id}/grants/${grantee.accountId}`));
    break;
  }
  case "list": {
    const [who] = args;
    const res = await http(who, "GET", "/v1/sessions");
    out({
      status: res.status,
      sessions: res.status === 200
        ? res.body.sessions.map((s) => ({ id: s.id, role: s.role, ownerId: s.ownerId, dataEncryptionKey: s.dataEncryptionKey, managed: s.managed, wasManagedAt: s.wasManagedAt }))
        : res.body,
    });
    break;
  }
  case "read": {
    const [who, name] = args;
    const session = readState(`session-${name}`);
    const res = await http(who, "GET", `/v3/sessions/${session.id}/messages`);
    out({
      status: res.status,
      messages: res.status === 200 ? res.body.messages.map((m) => ({ seq: m.seq, t: m.content.t, c: m.content.c })) : res.body,
    });
    break;
  }
  case "decrypt": {
    // The guest's app: open the re-wrapped key from its own list row, then
    // decrypt a stored message body with it. Exit 1 unless the fixture is
    // inside.
    const [who, name, ciphertext, fixture] = args;
    const session = readState(`session-${name}`);
    const key = await sessionKeyFor(who, session.id);
    const plain = enc.decrypt(key, "dataKey", unb64(ciphertext));
    const text = JSON.stringify(plain);
    if (!plain || !text.includes(fixture)) {
      console.error(`shared-sessions: decrypted content does not carry the fixture: ${text}`);
      process.exit(1);
    }
    out({ who, keyHex: hex(key), plaintext: plain });
    break;
  }
  case "send": {
    // The CLI: a session-scoped socket as the owner sends an encrypted
    // fixture message, while the guest's user-scoped socket (connected
    // FIRST, so nothing can race past it) reports whether it heard it.
    const [name, fixture, guest, waitMs] = args;
    const session = readState(`session-${name}`);
    const owner = readState("owner");
    const guestAccount = readState(guest);
    const guestSocket = await connect({ token: guestAccount.token, clientType: "user-scoped", happyClient: `shared-sessions/${guest}` });
    const heard = heardNewMessage(guestSocket, session.id, Number(waitMs));
    const cliSocket = await connect({ token: owner.token, clientType: "session-scoped", sessionId: session.id, happyClient: "shared-sessions/cli" });
    const ciphertext = b64(enc.encrypt(unb64(session.encryptionKey), session.encryptionVariant, fixtureContent(fixture)));
    cliSocket.emit("message", { sid: session.id, message: ciphertext, localId: randomUUID() });
    const guestReceived = await heard;
    cliSocket.close();
    guestSocket.close();
    out({ ciphertext, guestReceived });
    break;
  }
  case "post": {
    // The guest's phone answers: POST /v3 messages with content under the
    // session key it unwrapped from its own grant, while the CLI's
    // session-scoped socket (the owner's) reports whether the message
    // reached it.
    const [who, name, fixture, waitMs] = args;
    const session = readState(`session-${name}`);
    const owner = readState("owner");
    const cliSocket = await connect({ token: owner.token, clientType: "session-scoped", sessionId: session.id, happyClient: "shared-sessions/cli" });
    const heard = heardNewMessage(cliSocket, session.id, Number(waitMs));
    let ciphertext = null;
    try {
      const key = await sessionKeyFor(who, session.id);
      ciphertext = b64(enc.encrypt(key, "dataKey", fixtureContent(fixture)));
    } catch (error) {
      // No key for this caller (no grant): post garbage-shaped ciphertext so
      // the server's answer is measured on access, not on the body.
      ciphertext = b64(enc.getRandomBytes(64));
    }
    const res = await http(who, "POST", `/v3/sessions/${session.id}/messages`, { messages: [{ content: ciphertext, localId: randomUUID() }] });
    const cliReceived = res.status === 200 ? await heard : false;
    cliSocket.close();
    out({ status: res.status, body: res.body, cliReceived });
    break;
  }
  case "relay": {
    // GET /v1/relay is public: no account, no token. When the test holds the
    // relay's escrow seed (SHARED_SESSIONS_ESCROW_SEED), the announced public
    // key is checked against the key that seed derives.
    const res = await fetch(`${serverUrl}/v1/relay`);
    const body = await res.json();
    const seed = process.env.SHARED_SESSIONS_ESCROW_SEED;
    let escrowMatchesSeed = null;
    if (seed) {
      const expected = nacl.box.keyPair.fromSecretKey(Buffer.from(seed, "hex")).publicKey;
      escrowMatchesSeed = body.escrowPublicKey ? hex(unb64(body.escrowPublicKey)) === hex(expected) : false;
    }
    out({ status: res.status, body, escrowMatchesSeed });
    break;
  }
  case "escrow-open": {
    // The relay's side of a managed session, done by the test with the seed
    // it gave the relay: open the stored escrow wrap and compare it with the
    // key the CLI minted. Proves the CLI wrapped the RIGHT key to the RIGHT key.
    const [escrowKeyB64, name] = args;
    const seed = process.env.SHARED_SESSIONS_ESCROW_SEED;
    if (!seed) throw new Error("SHARED_SESSIONS_ESCROW_SEED is required");
    const session = readState(`session-${name}`);
    const opened = unwrap(escrowKeyB64, new Uint8Array(Buffer.from(seed, "hex")));
    out({ name, matchesMinted: hex(opened) === hex(unb64(session.encryptionKey)) });
    break;
  }
  case "create-session-raw": {
    // An older CLI, or a private session by hand: a dataKey session posted
    // WITHOUT an escrow wrap. Same request the CLI makes, minus the field,
    // so the Managed switch has something to turn on.
    const [who, name] = args;
    const account = readState(who);
    const key = enc.getRandomBytes(32);
    const res = await http(who, "POST", "/v1/sessions", {
      tag: `shared-sessions-${name}-${randomUUID()}`,
      metadata: b64(enc.encrypt(key, "dataKey", { path: `/tmp/shared-sessions/${name}`, host: "shared-sessions-test", name: `shared ${name}`, version: configuration.currentCliVersion })),
      agentState: null,
      dataEncryptionKey: b64(wrap(key, unb64(account.boxPublicKey))),
    });
    if (res.status !== 200) throw new Error(`create-session-raw: ${res.status} ${JSON.stringify(res.body)}`);
    writeState(`session-${name}`, { id: res.body.session.id, encryptionKey: b64(key), encryptionVariant: "dataKey" });
    out({ name, id: res.body.session.id });
    break;
  }
  case "escrow-on": {
    // The Managed switch, ON, as the owner's app does it: open its own
    // session key, wrap it to the relay's announced escrow public key, put
    // it. On a relay that announces none, put a well-formed wrap to a
    // throwaway key so the relay's own refusal is what gets measured.
    const [who, name] = args;
    const session = readState(`session-${name}`);
    const relay = await (await fetch(`${serverUrl}/v1/relay`)).json();
    const dataKey = await sessionKeyFor(who, session.id);
    const target = relay.escrowPublicKey ? unb64(relay.escrowPublicKey) : nacl.box.keyPair().publicKey;
    const escrowKey = b64(wrap(dataKey, target));
    out(await http(who, "PUT", `/v1/sessions/${session.id}/escrow`, { escrowKey }));
    break;
  }
  case "escrow-off": {
    // The Managed switch, OFF: the relay forgets its wrap, drops the grants
    // that had no key of their own, and remembers it held the key.
    const [who, name] = args;
    const session = readState(`session-${name}`);
    out(await http(who, "DELETE", `/v1/sessions/${session.id}/escrow`));
    break;
  }
  case "set-managed-default": {
    // The account's "new sessions managed" setting, as the app's account
    // settings write it.
    const [who, word] = args;
    out(await http(who, "PUT", "/v1/account/new-sessions-managed", { managed: word === "on" }));
    break;
  }
  case "machine-default": {
    // This machine's override, written the way the CLI's own settings
    // module writes it (the test's throwaway happy home, never ~/.happy).
    const [word] = args;
    const { updateSettings } = await import(`${cli}/persistence.ts`);
    await updateSettings((current) => {
      const next = { ...current };
      if (word === "unset") delete next.managedSessions;
      else next.managedSessions = word === "on";
      return next;
    });
    out({ managedSessions: word === "unset" ? null : word === "on" });
    break;
  }
  case "grant-managed": {
    // A grant on a managed session: principal and right, no key. The relay
    // makes the grantee's wrap itself.
    const [owner, name, guest, role] = args;
    const session = readState(`session-${name}`);
    const grantee = readState(guest);
    out(await http(owner, "POST", `/v1/sessions/${session.id}/grants`, { granteeAccountId: grantee.accountId, role }));
    break;
  }
  case "set-kind": {
    // The "may add machines" switch: PUT /v1/accounts/:id/kind as `who`.
    const [who, target, kind] = args;
    const account = readState(target);
    out(await http(who, "PUT", `/v1/accounts/${account.accountId}/kind`, { kind }));
    break;
  }
  case "accounts": {
    const [who] = args;
    out(await http(who, "GET", "/v1/accounts"));
    break;
  }
  default:
    console.error("shared-sessions: unknown command " + cmd);
    process.exit(2);
}
