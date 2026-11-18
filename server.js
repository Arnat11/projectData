const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { MongoClient, ObjectId } = require("mongodb");

const ROOT = __dirname;
const CATEGORIES = new Set(["purifiers", "filters", "monitors", "accessories"]);
const PUBLIC_FILES = new Set([
  "index.html", "admin.html", "account.html", "store.js", "admin.js", "account.js",
  "assets/store.css", "assets/hero.jpg", "assets/products.jpg",
]);
const PASSWORD_MIN = 10;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const scrypt = promisify(crypto.scrypt);
const loginAttempts = new Map();

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || match[1].startsWith("#") || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const DB_NAME = process.env.MONGODB_DB || "airify_store";
const NODE_ENV = process.env.NODE_ENV || "development";
const configuredSessionSecret = process.env.SESSION_SECRET || "";
const secretIsUsable = configuredSessionSecret.length >= 32 && !configuredSessionSecret.startsWith("replace-with");
const SESSION_SECRET = secretIsUsable ? configuredSessionSecret : (NODE_ENV === "production" ? "" : crypto.randomBytes(48).toString("hex"));
const MONGODB_URI = process.env.MONGODB_URI;

function adminConfigReady() {
  const username = process.env.ADMIN_USERNAME?.trim().toLowerCase() || "";
  const password = process.env.ADMIN_PASSWORD || "";
  return validUsername(username) && password.length >= PASSWORD_MIN && !password.startsWith("replace-with");
}

if (!MONGODB_URI) {
  console.error("ตั้งค่า MONGODB_URI ในไฟล์ .env ก่อนเริ่มระบบ");
  process.exit(1);
}
if (NODE_ENV === "production" && SESSION_SECRET.length < 32) {
  console.error("ตั้งค่า SESSION_SECRET ให้ยาวอย่างน้อย 32 ตัวอักษรใน production");
  process.exit(1);
}
if (NODE_ENV !== "production" && !secretIsUsable) {
  console.warn("ยังไม่ได้ตั้ง SESSION_SECRET; session จะหมดเมื่อรีสตาร์ตเซิร์ฟเวอร์");
}

const client = new MongoClient(MONGODB_URI, { appName: "Airify Store", serverSelectionTimeoutMS: 10000 });
let db;
let collections;

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(303, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, "ข้อมูลที่ส่งมีขนาดใหญ่เกินไป");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new HttpError(400, "รูปแบบข้อมูลไม่ถูกต้อง"); }
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function sessionCookie(token, maxAge = Math.floor(SESSION_TTL_MS / 1000)) {
  const secure = NODE_ENV === "production" ? "; Secure" : "";
  return `airify_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function hashToken(token) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(token).digest("hex");
}

async function currentSession(req) {
  const token = parseCookies(req.headers.cookie).airify_session;
  if (!token) return null;
  const session = await collections.sessions.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } });
  if (!session) return null;
  const user = await collections.users.findOne({ _id: session.userId }, { projection: { username: 1, displayName: 1, role: 1 } });
  if (!user) return null;
  return { tokenHash: session.tokenHash, csrfToken: session.csrfToken, user };
}

async function createSession(res, user) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrfToken = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await collections.sessions.insertOne({ tokenHash: hashToken(token), userId: user._id, role: user.role, csrfToken, createdAt: new Date(), expiresAt });
  res.setHeader("Set-Cookie", sessionCookie(token));
  return { id: user._id.toString(), username: user.username, displayName: user.displayName || user.username, role: user.role, csrfToken };
}

function requireRole(session, role) {
  if (!session) throw new HttpError(401, "กรุณาเข้าสู่ระบบก่อน");
  if (session.user.role !== role) throw new HttpError(403, "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้");
}

function requireCsrf(req, session) {
  if (!session || !req.headers["x-csrf-token"] || req.headers["x-csrf-token"] !== session.csrfToken) {
    throw new HttpError(403, "เซสชันหมดอายุ กรุณาโหลดหน้าเว็บใหม่");
  }
}

function validUsername(value) {
  return typeof value === "string" && /^[\p{L}\p{N}_.-]{3,32}$/u.test(value.trim());
}

async function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64);
  return `${salt}:${key.toString("hex")}`;
}

async function passwordMatches(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = await scrypt(password, salt, 64);
  const known = Buffer.from(hash, "hex");
  return known.length === candidate.length && crypto.timingSafeEqual(known, candidate);
}

function rateLimitLogin(req, username) {
  const key = `${req.socket.remoteAddress || "unknown"}:${String(username || "").toLowerCase()}`;
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (current && current.until > now && current.count >= LOGIN_MAX_ATTEMPTS) throw new HttpError(429, "ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่");
  if (!current || current.until <= now) loginAttempts.set(key, { count: 1, until: now + LOGIN_WINDOW_MS });
  else current.count += 1;
  return key;
}

function cleanProduct(input, previous = {}) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const category = typeof input.category === "string" ? input.category : "";
  const spec = typeof input.spec === "string" ? input.spec.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const image = typeof input.image === "string" ? input.image.trim() : (previous.image || "");
  const price = Number(input.price);
  const stock = Number(input.stock);
  if (!name || name.length > 120) throw new HttpError(400, "กรุณากรอกชื่อสินค้าไม่เกิน 120 ตัวอักษร");
  if (!CATEGORIES.has(category)) throw new HttpError(400, "กรุณาเลือกหมวดหมู่สินค้า");
  if (!Number.isFinite(price) || price < 0 || price > 100000000) throw new HttpError(400, "ราคาสินค้าไม่ถูกต้อง");
  if (!Number.isInteger(stock) || stock < 0 || stock > 1000000) throw new HttpError(400, "จำนวนสินค้าในสต็อกไม่ถูกต้อง");
  if (spec.length > 240 || description.length > 2000) throw new HttpError(400, "รายละเอียดสินค้ายาวเกินไป");
  if (!allowedImage(image)) {
    throw new HttpError(400, "รูปภาพต้องเป็น URL HTTPS, /assets/ หรือภาพตัวอย่างในร้าน");
  }
  return { name, category, spec, price, stock, image: image || previous.image || "", description, isActive: true };
}

function serializedProduct(product) {
  return {
    id: product._id.toString(),
    name: product.name,
    category: product.category,
    spec: product.spec || "",
    price: product.price,
    stock: product.stock,
    image: product.image || "",
    description: product.description || "",
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function allowedImage(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  return value.startsWith("sprite:") || value.startsWith("/assets/") || /^https:\/\//i.test(value);
}

async function signIn(req, res, body, role) {
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const rateKey = rateLimitLogin(req, username);
  const user = await collections.users.findOne({ username, role });
  if (!user || !(await passwordMatches(body.password, user.passwordHash))) throw new HttpError(401, "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
  loginAttempts.delete(rateKey);
  const publicUser = await createSession(res, user);
  return { user: publicUser };
}

async function ensureAdmin() {
  const username = process.env.ADMIN_USERNAME?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!adminConfigReady()) {
    console.warn("ยังไม่ได้สร้างบัญชีผู้ดูแล; กำหนด ADMIN_USERNAME และ ADMIN_PASSWORD ใน .env");
    return;
  }
  const passwordDigest = await passwordHash(password);
  const existing = await collections.users.findOne({ username });
  if (existing && existing.role !== "admin") {
    console.error("สร้างบัญชีผู้ดูแลไม่ได้: ชื่อผู้ใช้นี้เป็นบัญชีลูกค้าอยู่แล้ว กรุณาเลือก ADMIN_USERNAME อื่นใน .env");
    return;
  }
  if (existing) await collections.users.updateOne({ _id: existing._id }, { $set: { displayName: "ผู้ดูแลร้าน", passwordHash: passwordDigest, updatedAt: new Date() } });
  else await collections.users.insertOne({ username, displayName: "ผู้ดูแลร้าน", role: "admin", passwordHash: passwordDigest, createdAt: new Date(), updatedAt: new Date() });
}

async function seedProducts() {
  const count = await collections.products.countDocuments();
  if (count > 0) return;
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "products.seed.json"), "utf8"));
  const now = new Date();
  await collections.products.insertMany(seed.map((item) => ({ ...item, isActive: true, createdAt: now, updatedAt: now })));
  console.log(`เพิ่มสินค้าเริ่มต้น ${seed.length} รายการลง MongoDB แล้ว`);
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml" })[ext] || "application/octet-stream";
}

async function serveStatic(req, res, pathname, session) {
  if (pathname === "/admin.html" && session?.user.role === "customer") return redirect(res, "/account.html?error=admin");
  const relative = decodeURIComponent(pathname === "/" ? "/index.html" : pathname).replace(/^\/+/, "");
  if (!PUBLIC_FILES.has(relative)) return false;
  const file = path.resolve(ROOT, relative);
  if (!file.startsWith(`${ROOT}${path.sep}`)) return false;
  let content;
  try { content = await fs.promises.readFile(file); } catch { return false; }
  res.writeHead(200, {
    "Content-Type": contentType(file),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cache-Control": file.endsWith(".html") ? "no-store" : "public, max-age=3600",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' https: data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(content);
  return true;
}

async function checkout(body, session) {
  const name = typeof body.customerName === "string" ? body.customerName.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (name.length < 2 || name.length > 120 || phone.length < 8 || phone.length > 32 || address.length < 8 || address.length > 1000) {
    throw new HttpError(400, "กรุณาตรวจสอบชื่อ เบอร์โทรศัพท์ และที่อยู่จัดส่ง");
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) throw new HttpError(400, "กรุณาเลือกสินค้าในตะกร้า");
  const quantities = new Map();
  for (const line of body.items) {
    if (!line || !ObjectId.isValid(line.productId) || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) {
      throw new HttpError(400, "รายการสินค้าไม่ถูกต้อง");
    }
    const id = new ObjectId(line.productId).toString();
    quantities.set(id, (quantities.get(id) || 0) + line.quantity);
  }
  const productIds = [...quantities.keys()].map((id) => new ObjectId(id));
  const found = await collections.products.find({ _id: { $in: productIds }, isActive: true }).toArray();
  if (found.length !== productIds.length) throw new HttpError(409, "มีสินค้าบางรายการถูกนำออกจากร้านแล้ว กรุณาปรับตะกร้าใหม่");
  const byId = new Map(found.map((product) => [product._id.toString(), product]));
  const items = [...quantities].map(([id, quantity]) => {
    const product = byId.get(id);
    if (quantity > product.stock) throw new HttpError(409, `${product.name} มีสินค้าไม่พอตามจำนวนที่เลือก`);
    return { productId: product._id, name: product.name, category: product.category, image: product.image, price: product.price, quantity };
  });
  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const order = {
    userId: session.user._id,
    username: session.user.username,
    customer: { name, phone, address },
    items,
    total,
    status: "new",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mongoSession = client.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      for (const item of items) {
        const result = await collections.products.updateOne(
          { _id: item.productId, isActive: true, stock: { $gte: item.quantity } },
          { $inc: { stock: -item.quantity }, $set: { updatedAt: new Date() } },
          { session: mongoSession },
        );
        if (result.modifiedCount !== 1) throw new HttpError(409, `${item.name} มีสินค้าไม่พอตามจำนวนที่เลือก`);
      }
      await collections.orders.insertOne(order, { session: mongoSession });
    });
  } catch (error) {
    const unsupported = error.code === 20 || error.code === 303 || /Transaction numbers are only allowed|replica set|mongos/i.test(error.message || "");
    if (!unsupported) throw error;
    await checkoutWithCompensation(order, items);
  } finally {
    await mongoSession.endSession();
  }
  return { id: order._id?.toString() || "", total, itemCount: items.reduce((sum, item) => sum + item.quantity, 0) };
}

async function checkoutWithCompensation(order, items) {
  const reserved = [];
  try {
    for (const item of items) {
      const result = await collections.products.updateOne(
        { _id: item.productId, isActive: true, stock: { $gte: item.quantity } },
        { $inc: { stock: -item.quantity }, $set: { updatedAt: new Date() } },
      );
      if (result.modifiedCount !== 1) throw new HttpError(409, `${item.name} มีสินค้าไม่พอตามจำนวนที่เลือก`);
      reserved.push(item);
    }
    const result = await collections.orders.insertOne(order);
    return result;
  } catch (error) {
    await Promise.all(reserved.map((item) => collections.products.updateOne({ _id: item.productId }, { $inc: { stock: item.quantity }, $set: { updatedAt: new Date() } })));
    throw error;
  }
}

async function handleApi(req, res, url, session) {
  const { pathname, searchParams } = url;
  if (req.method === "GET" && pathname === "/api/health") return json(res, 200, { ok: true, database: "connected" });

  if (req.method === "GET" && pathname === "/api/auth/me") {
    return json(res, 200, { user: session ? { id: session.user._id.toString(), username: session.user.username, displayName: session.user.displayName || session.user.username, role: session.user.role, csrfToken: session.csrfToken } : null, adminConfigured: adminConfigReady() });
  }

  if (req.method === "POST" && pathname === "/api/auth/customer/register") {
    const body = await readJson(req);
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (!validUsername(username)) throw new HttpError(400, "ชื่อผู้ใช้ต้องยาว 3-32 ตัว และใช้ตัวอักษรหรือตัวเลข");
    if (username === process.env.ADMIN_USERNAME?.trim().toLowerCase()) throw new HttpError(409, "ชื่อผู้ใช้นี้สงวนไว้สำหรับผู้ดูแลร้าน");
    if (typeof body.password !== "string" || body.password.length < PASSWORD_MIN || body.password.length > 128) throw new HttpError(400, `รหัสผ่านต้องมีอย่างน้อย ${PASSWORD_MIN} ตัวอักษร`);
    if (displayName.length < 2 || displayName.length > 80) throw new HttpError(400, "กรุณากรอกชื่อที่แสดง 2-80 ตัวอักษร");
    const user = { username, displayName, role: "customer", passwordHash: await passwordHash(body.password), createdAt: new Date(), updatedAt: new Date() };
    try { const result = await collections.users.insertOne(user); user._id = result.insertedId; }
    catch (error) { if (error.code === 11000) throw new HttpError(409, "ชื่อผู้ใช้นี้ถูกใช้แล้ว"); throw error; }
    return json(res, 201, { user: await createSession(res, user) });
  }

  if (req.method === "POST" && pathname === "/api/auth/customer/login") {
    const result = await signIn(req, res, await readJson(req), "customer");
    return json(res, 200, result);
  }

  if (req.method === "POST" && pathname === "/api/auth/admin/login") {
    if (!adminConfigReady()) throw new HttpError(503, "ยังไม่ได้ตั้งค่าบัญชีผู้ดูแลในไฟล์ .env");
    const result = await signIn(req, res, await readJson(req), "admin");
    return json(res, 200, result);
  }

  if (req.method === "POST" && pathname === "/api/auth/logout") {
    if (session) {
      requireCsrf(req, session);
      await collections.sessions.deleteOne({ tokenHash: session.tokenHash });
    }
    res.setHeader("Set-Cookie", sessionCookie("", 0));
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && pathname === "/api/products") {
    const filter = { isActive: true };
    const category = searchParams.get("category") || "";
    const search = (searchParams.get("search") || "").trim().slice(0, 100);
    const sort = searchParams.get("sort") || "featured";
    if (category && CATEGORIES.has(category)) filter.category = category;
    if (search) {
      const pattern = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ name: pattern }, { spec: pattern }, { description: pattern }];
    }
    const sortSpec = sort === "priceLow" ? { price: 1, name: 1 } : sort === "priceHigh" ? { price: -1, name: 1 } : { createdAt: 1, _id: 1 };
    const items = await collections.products.find(filter).sort(sortSpec).limit(300).toArray();
    return json(res, 200, { items: items.map(serializedProduct), total: items.length });
  }

  const productDetail = pathname.match(/^\/api\/products\/([a-f\d]{24})$/i);
  if (req.method === "GET" && productDetail) {
    const item = await collections.products.findOne({ _id: new ObjectId(productDetail[1]), isActive: true });
    if (!item) throw new HttpError(404, "ไม่พบสินค้านี้");
    return json(res, 200, { item: serializedProduct(item) });
  }

  if (req.method === "GET" && pathname === "/api/admin/products") {
    requireRole(session, "admin");
    const items = await collections.products.find({}).sort({ createdAt: -1 }).limit(500).toArray();
    return json(res, 200, { items: items.map(serializedProduct), total: items.length });
  }

  if (req.method === "POST" && pathname === "/api/admin/products") {
    requireRole(session, "admin");
    requireCsrf(req, session);
    const body = await readJson(req);
    const item = { ...cleanProduct(body), createdAt: new Date(), updatedAt: new Date() };
    const result = await collections.products.insertOne(item);
    return json(res, 201, { item: serializedProduct({ ...item, _id: result.insertedId }) });
  }

  const adminProduct = pathname.match(/^\/api\/admin\/products\/([a-f\d]{24})$/i);
  if (adminProduct && req.method === "PUT") {
    requireRole(session, "admin");
    requireCsrf(req, session);
    const body = await readJson(req);
    const _id = new ObjectId(adminProduct[1]);
    const existing = await collections.products.findOne({ _id });
    if (!existing) throw new HttpError(404, "ไม่พบสินค้านี้");
    const item = cleanProduct(body, existing);
    await collections.products.updateOne({ _id }, { $set: { ...item, updatedAt: new Date() } });
    return json(res, 200, { item: serializedProduct({ ...existing, ...item, _id }) });
  }

  if (adminProduct && req.method === "DELETE") {
    requireRole(session, "admin");
    requireCsrf(req, session);
    const result = await collections.products.deleteOne({ _id: new ObjectId(adminProduct[1]) });
    if (!result.deletedCount) throw new HttpError(404, "ไม่พบสินค้านี้");
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/orders") {
    requireRole(session, "customer");
    requireCsrf(req, session);
    const result = await checkout(await readJson(req), session);
    return json(res, 201, { orderId: result.id, total: result.total, itemCount: result.itemCount });
  }

  if (req.method === "GET" && pathname === "/api/orders/mine") {
    requireRole(session, "customer");
    const orders = await collections.orders.find({ userId: session.user._id }).sort({ createdAt: -1 }).limit(100).toArray();
    return json(res, 200, { items: orders.map((order) => ({ id: order._id.toString(), total: order.total, status: order.status, items: order.items, createdAt: order.createdAt })) });
  }

  if (req.method === "GET" && pathname === "/api/admin/orders") {
    requireRole(session, "admin");
    const orders = await collections.orders.find({}).sort({ createdAt: -1 }).limit(200).toArray();
    return json(res, 200, { items: orders.map((order) => ({ id: order._id.toString(), username: order.username, customer: order.customer, items: order.items, total: order.total, status: order.status, createdAt: order.createdAt })) });
  }

  return false;
}

async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    const session = await currentSession(req);
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url, session);
      if (handled !== false) return;
      return json(res, 404, { error: "ไม่พบ API นี้" });
    }
    const served = await serveStatic(req, res, url.pathname, session);
    if (!served) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
      res.end("ไม่พบหน้าที่ต้องการ");
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error(error);
    if (!res.headersSent) json(res, status, { error: status === 500 ? "เกิดข้อผิดพลาดภายในระบบ" : error.message, code: error.code });
    else res.end();
  }
}

async function start() {
  await client.connect();
  db = client.db(DB_NAME);
  collections = {
    products: db.collection("products"),
    users: db.collection("users"),
    sessions: db.collection("sessions"),
    orders: db.collection("orders"),
  };
  await Promise.all([
    collections.users.createIndex({ username: 1 }, { unique: true }),
    collections.sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    collections.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    collections.orders.createIndex({ userId: 1, createdAt: -1 }),
    collections.orders.createIndex({ createdAt: -1 }),
    collections.products.createIndex({ category: 1, isActive: 1 }),
    collections.products.createIndex({ name: 1 }),
  ]);
  await Promise.all([seedProducts(), ensureAdmin()]);
  const server = http.createServer(requestHandler);
  server.listen(PORT, () => console.log(`Airify Store พร้อมใช้งานที่ http://localhost:${PORT}`));
  const close = async () => {
    server.close();
    await client.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

start().catch(async (error) => {
  console.error("เริ่มระบบไม่ได้ กรุณาตรวจสอบ MONGODB_URI และสิทธิ์การเชื่อมต่อ MongoDB");
  console.error(error.message);
  await client.close().catch(() => {});
  process.exit(1);
});
