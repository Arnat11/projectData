const categoryNames = {
  purifiers: "เครื่องฟอกอากาศ",
  filters: "ไส้กรองอากาศ",
  monitors: "เครื่องวัดคุณภาพอากาศ",
  accessories: "อุปกรณ์เสริม",
};

const productGrid = document.querySelector("#products");
const productCount = document.querySelector("#product-count");
const searchInput = document.querySelector("#search");
const sortSelect = document.querySelector("#sort");
const productDialog = document.querySelector("#product-dialog");
const cartDialog = document.querySelector("#cart-dialog");
const notice = document.querySelector("#notice");
let allProducts = [];
let activeCategory = "";
let cart = readCart();
let auth = { user: null };
let noticeTimer;

function readCart() {
  try {
    const saved = JSON.parse(localStorage.getItem("airify-cart") || "{}");
    if (!saved || typeof saved !== "object") return {};
    return Object.fromEntries(Object.entries(saved).filter(([id, quantity]) => /^[a-f\d]{24}$/i.test(id) && Number.isInteger(Number(quantity)) && Number(quantity) > 0));
  } catch { return {}; }
}

function saveCart() {
  try { localStorage.setItem("airify-cart", JSON.stringify(cart)); } catch { /* Storage may be disabled. */ }
  updateCartCount();
}

async function api(url, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  const response = await fetch(url, { credentials: "same-origin", ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "เกิดข้อผิดพลาด กรุณาลองใหม่");
    error.status = response.status;
    throw error;
  }
  return data;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function money(value) {
  return `฿${Number(value).toLocaleString("th-TH")}`;
}

function stockLabel(product) {
  return product.stock ? `เหลือ ${product.stock} ชิ้น` : "สินค้าหมด";
}

function productArt(product, alt = product.name) {
  const image = product.image || "";
  if (image.startsWith("sprite:")) {
    const position = image.slice("sprite:".length);
    return `<div class="product-art" role="img" aria-label="ภาพตัวอย่าง ${escapeHtml(alt)}"><span class="product-sprite" style="background-position:${escapeHtml(position)}"></span></div>`;
  }
  return `<div class="product-art"><img src="${escapeHtml(image)}" alt="${escapeHtml(alt)}" loading="lazy"></div>`;
}

function productCard(product) {
  const stockClass = product.stock ? "stock" : "stock empty";
  return `<article class="product-card">
    ${productArt(product)}
    <div class="card-body">
      <p class="product-category">${categoryNames[product.category] || "สินค้า"}</p>
      <h3>${escapeHtml(product.name)}</h3>
      <p class="product-spec">${escapeHtml(product.spec || "")}</p>
      <div class="card-meta"><strong class="price">${money(product.price)}</strong><span class="${stockClass}">${stockLabel(product)}</span></div>
      <div class="card-actions">
        <button type="button" class="button button-primary" data-add="${escapeHtml(product.id)}" aria-label="ใส่ตะกร้า ${escapeHtml(product.name)}" ${product.stock ? "" : "disabled"}>ใส่ตะกร้า</button>
        <button type="button" class="button button-text" data-detail="${escapeHtml(product.id)}" aria-label="รายละเอียด ${escapeHtml(product.name)}" aria-haspopup="dialog">รายละเอียด</button>
      </div>
    </div>
  </article>`;
}

function renderProducts() {
  const search = searchInput.value.trim().toLocaleLowerCase("th-TH");
  let visible = allProducts
    .filter((product) => (!activeCategory || product.category === activeCategory))
    .filter((product) => !search || `${product.name} ${product.spec || ""} ${product.description || ""} ${categoryNames[product.category] || ""}`.toLocaleLowerCase("th-TH").includes(search));
  if (sortSelect.value === "priceLow") visible.sort((a, b) => a.price - b.price);
  if (sortSelect.value === "priceHigh") visible.sort((a, b) => b.price - a.price);
  productCount.textContent = `พบสินค้า ${visible.length} รายการ`;
  if (!visible.length) {
    productGrid.innerHTML = `<div class="blank"><p>ไม่พบสินค้าที่ตรงกับคำค้นหา</p><button class="button button-quiet" id="clear-filters" type="button">ล้างตัวกรอง</button></div>`;
    return;
  }
  productGrid.innerHTML = visible.map(productCard).join("");
}

function updateCategoryButtons() {
  document.querySelectorAll(".category-button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.category === activeCategory));
  });
}

function updateCartCount() {
  const count = Object.values(cart).reduce((sum, value) => sum + Number(value || 0), 0);
  document.querySelector("#cart-count").textContent = String(count);
}

function updateAccountLink() {
  const link = document.querySelector("#account-link");
  if (!link) return;
  if (auth.user?.role === "admin") {
    link.href = "./admin.html";
    link.textContent = "จัดการร้าน";
  } else if (auth.user?.role === "customer") {
    link.href = "./account.html";
    link.textContent = `สวัสดี ${auth.user.displayName}`;
  } else {
    link.href = "./account.html";
    link.textContent = "เข้าสู่ระบบ";
  }
}

async function loadAuth() {
  try {
    auth = await api("/api/auth/me");
    updateAccountLink();
  } catch { auth = { user: null }; }
}

async function loadProducts() {
  productGrid.setAttribute("aria-busy", "true");
  try {
    const result = await api("/api/products");
    allProducts = result.items || [];
    productGrid.setAttribute("aria-busy", "false");
    renderProducts();
  } catch (error) {
    productGrid.setAttribute("aria-busy", "false");
    productCount.textContent = "เชื่อมต่อฐานข้อมูลสินค้าไม่ได้";
    productGrid.innerHTML = `<div class="blank"><p>${escapeHtml(error.message)}</p><p class="muted">กรุณาเปิดเว็บผ่านเซิร์ฟเวอร์และตรวจสอบการเชื่อมต่อ MongoDB</p><button class="button button-quiet" type="button" id="retry-products">ลองอีกครั้ง</button></div>`;
  }
}

function showNotice(message) {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.hidden = false;
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 2800);
}

function addToCart(productId) {
  const product = allProducts.find((item) => item.id === productId);
  if (!product || product.stock < 1) return;
  cart[productId] = Math.min(Number(cart[productId] || 0) + 1, product.stock);
  saveCart();
  showNotice(`เพิ่ม ${product.name} ลงตะกร้าแล้ว`);
}

function openProduct(productId) {
  const product = allProducts.find((item) => item.id === productId);
  if (!product) return;
  const stockClass = product.stock ? "stock" : "stock empty";
  productDialog.innerHTML = `<div class="dialog-head"><h2 id="product-dialog-title">${escapeHtml(product.name)}</h2><button class="button button-quiet" type="button" data-close-product aria-label="ปิดรายละเอียด">✕</button></div>
    <div class="dialog-content">
      ${productArt(product)}
      <p class="product-category">${categoryNames[product.category] || "สินค้า"}</p>
      <p>${escapeHtml(product.spec || "")}</p>
      <div class="card-meta"><strong class="price">${money(product.price)}</strong><span class="${stockClass}">${stockLabel(product)}</span></div>
      <p>${escapeHtml(product.description || "อุปกรณ์ดูแลคุณภาพอากาศสำหรับบ้าน")}</p>
      <div class="dialog-actions"><button class="button button-primary" type="button" data-dialog-add="${escapeHtml(product.id)}" ${product.stock ? "" : "disabled"}>ใส่ตะกร้า</button></div>
    </div>`;
  productDialog.showModal();
}

function cartEntries() {
  return Object.entries(cart).map(([id, quantity]) => ({ product: allProducts.find((item) => item.id === id), quantity: Number(quantity) })).filter((line) => line.product && line.quantity > 0);
}

function renderCart() {
  const lines = cartEntries();
  const total = lines.reduce((sum, { product, quantity }) => sum + product.price * quantity, 0);
  const body = lines.length ? `<div class="cart-items">${lines.map(({ product, quantity }) => `
      <div class="cart-line"><div><strong>${escapeHtml(product.name)}</strong><span class="muted">${money(product.price)} / ชิ้น</span></div>
      <input type="number" min="1" max="${product.stock}" value="${quantity}" data-quantity="${escapeHtml(product.id)}" aria-label="จำนวน ${escapeHtml(product.name)}">
      <button class="button button-text" type="button" data-remove="${escapeHtml(product.id)}" aria-label="นำ ${escapeHtml(product.name)} ออกจากตะกร้า">ลบ</button></div>`).join("")}</div>
      <div class="total"><span>ยอดรวม</span><strong>${money(total)}</strong></div>
      <form id="checkout">
        <label>ชื่อผู้รับสินค้า<input name="customerName" autocomplete="name" required value="${escapeHtml(auth.user?.displayName || "")}" placeholder="ชื่อและนามสกุล"></label>
        <label>เบอร์โทรศัพท์<small>ใช้สำหรับติดต่อเรื่องการจัดส่ง</small><input name="phone" autocomplete="tel" inputmode="tel" required placeholder="08x-xxx-xxxx"></label>
        <label>ที่อยู่จัดส่ง<textarea name="address" autocomplete="street-address" rows="3" required placeholder="บ้านเลขที่ ถนน แขวง/ตำบล เขต/อำเภอ จังหวัด รหัสไปรษณีย์"></textarea></label>
        ${auth.user?.role === "customer" ? `<button class="button button-primary full" type="submit">ยืนยันคำสั่งซื้อ</button>` : `<p class="form-error">กรุณาเข้าสู่ระบบในฐานะลูกค้าก่อนสั่งซื้อ</p><a class="button button-primary full" href="./account.html">เข้าสู่ระบบ / สมัครสมาชิก</a>`}
      </form>` : `<p class="muted">ยังไม่มีสินค้าในตะกร้า</p><a class="button button-primary full" href="#catalog" data-continue-shopping>เลือกซื้อสินค้า</a>`;
  cartDialog.innerHTML = `<div class="dialog-head"><h2 id="cart-title">ตะกร้าสินค้า</h2><button class="button button-quiet" type="button" data-close-cart aria-label="ปิดตะกร้า">✕</button></div><div class="dialog-content">${body}</div>`;
}

function openCart() {
  renderCart();
  cartDialog.showModal();
}

document.querySelector("#catalog-search").addEventListener("submit", (event) => {
  event.preventDefault();
  renderProducts();
  document.querySelector("#catalog").scrollIntoView({ behavior: "smooth" });
});
searchInput.addEventListener("input", renderProducts);
sortSelect.addEventListener("change", renderProducts);

document.querySelector("#categories").addEventListener("click", (event) => {
  const button = event.target.closest(".category-button");
  if (!button) return;
  activeCategory = button.dataset.category;
  updateCategoryButtons();
  renderProducts();
});

document.querySelector("#category-directory").addEventListener("click", (event) => {
  const link = event.target.closest(".category-link");
  if (!link) return;
  activeCategory = link.dataset.category;
  updateCategoryButtons();
  renderProducts();
});

productGrid.addEventListener("click", (event) => {
  const addButton = event.target.closest("[data-add]");
  if (addButton) return addToCart(addButton.dataset.add);
  const detailButton = event.target.closest("[data-detail]");
  if (detailButton) return openProduct(detailButton.dataset.detail);
  if (event.target.closest("#clear-filters")) {
    activeCategory = "";
    searchInput.value = "";
    updateCategoryButtons();
    renderProducts();
  }
  if (event.target.closest("#retry-products")) loadProducts();
});

productDialog.addEventListener("click", (event) => {
  if (event.target.closest("[data-close-product]")) productDialog.close();
  const addButton = event.target.closest("[data-dialog-add]");
  if (addButton) {
    addToCart(addButton.dataset.dialogAdd);
    productDialog.close();
  }
});

document.querySelector("#cart-open").addEventListener("click", openCart);
cartDialog.addEventListener("click", (event) => {
  if (event.target.closest("[data-close-cart]")) cartDialog.close();
  const removeButton = event.target.closest("[data-remove]");
  if (removeButton) {
    delete cart[removeButton.dataset.remove];
    saveCart();
    renderCart();
  }
  if (event.target.closest("[data-continue-shopping]")) cartDialog.close();
});

cartDialog.addEventListener("change", (event) => {
  const input = event.target.closest("[data-quantity]");
  if (!input) return;
  const product = allProducts.find((item) => item.id === input.dataset.quantity);
  if (!product) return;
  cart[product.id] = Math.max(1, Math.min(Number(input.value) || 1, product.stock));
  saveCart();
  renderCart();
});

cartDialog.addEventListener("submit", async (event) => {
  if (event.target.id !== "checkout") return;
  event.preventDefault();
  if (auth.user?.role !== "customer") return;
  const form = new FormData(event.target);
  const payload = {
    customerName: String(form.get("customerName") || "").trim(),
    phone: String(form.get("phone") || "").trim(),
    address: String(form.get("address") || "").trim(),
    items: cartEntries().map(({ product, quantity }) => ({ productId: product.id, quantity })),
  };
  try {
    const order = await api("/api/orders", { method: "POST", headers: { "X-CSRF-Token": auth.user.csrfToken }, body: JSON.stringify(payload) });
    cart = {};
    saveCart();
    await loadProducts();
    cartDialog.querySelector(".dialog-content").innerHTML = `<div class="receipt"><h3>บันทึกคำสั่งซื้อแล้ว</h3><p>หมายเลขคำสั่งซื้อ ${escapeHtml(order.orderId)}</p><p>ยอดรวม ${money(order.total)}</p></div><div class="dialog-actions"><button class="button button-primary" type="button" data-close-cart>กลับไปเลือกสินค้า</button></div>`;
  } catch (error) {
    showNotice(error.message);
    if (error.status === 401 || error.status === 403) window.location.href = "./account.html";
  }
});

updateCartCount();
Promise.all([loadAuth(), loadProducts()]);
