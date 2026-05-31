const db = require('../db/database');
const { sendMessage } = require('../whatsapp');

const SHIPPING = 350;
const PAYMENT_LABELS = { cod:'Cash on Delivery (COD)', bank_transfer:'Bank Transfer', koko:'Koko', mintpay:'Mintpay' };

async function handleOrderFlow(domain, phone, text, shop) {
  const lower = text.toLowerCase().trim();
  const contact = db.getContact(domain, phone) || { state: 'idle', cart: [], temp_data: {} };
  const state = contact.state || 'idle';
  const cart = contact.cart || [];
  const temp = contact.temp_data || {};

  // IDLE — detect order intent
  if (state === 'idle') {
    const triggers = ['order','buy','purchase','want','need','ගන්න','order කරන්න','price','මිල','catalogue','catalog','products'];
    if (!triggers.some(t => lower.includes(t))) return null;
    const products = db.getProducts(domain);
    if (!products.length) return null;
    const list = products.map((p,i) => `${i+1}. *${p.name}* — Rs.${Math.min(...(p.variants||[]).map(v=>v.price)||[0]).toLocaleString()}+`).join('\n');
    db.updateContactState(domain, phone, 'selecting_product', [], { products: products.map(p=>({...p,variants:p.variants})) });
    return `🛍 Our products:\n\n${list}\n\nReply with the *number* to order.`;
  }

  // SELECTING PRODUCT
  if (state === 'selecting_product') {
    const products = temp.products || db.getProducts(domain);
    const num = parseInt(text); const product = products[num-1];
    if (!product) return `Please reply with a number between 1 and ${products.length}.`;
    const vList = (product.variants||[]).map((v,i) => `${i+1}. ${v.name} — Rs.${v.price.toLocaleString()} ${v.stock>0?'✅':'❌ Out of stock'}`).join('\n');
    db.updateContactState(domain, phone, 'selecting_variant', cart, { ...temp, product });
    return `*${product.name}*\n${product.description||''}\n\nChoose variant:\n\n${vList}`;
  }

  // SELECTING VARIANT
  if (state === 'selecting_variant') {
    const num = parseInt(text); const product = temp.product;
    const variant = (product?.variants||[])[num-1];
    if (!variant) return `Please reply 1–${(product?.variants||[]).length}.`;
    if (variant.stock === 0) return `Sorry, ${variant.name} is out of stock. Choose another.`;
    db.updateContactState(domain, phone, 'selecting_qty', cart, { ...temp, selected_variant: variant });
    return `*${product.name} — ${variant.name}* (Rs.${variant.price.toLocaleString()})\n\nHow many? Reply with a number.`;
  }

  // SELECTING QTY
  if (state === 'selecting_qty') {
    const qty = parseInt(text);
    if (!qty || qty < 1 || qty > 20) return `Please reply with a number between 1 and 20.`;
    const item = { product_name: temp.product.name, variant: temp.selected_variant.name, qty, price: temp.selected_variant.price };
    const newCart = [...cart, item];
    const subtotal = newCart.reduce((s,i)=>s+i.price*i.qty, 0);
    db.updateContactState(domain, phone, 'add_more', newCart, temp);
    const summary = newCart.map(i=>`• ${i.product_name} (${i.variant}) x${i.qty} — Rs.${(i.price*i.qty).toLocaleString()}`).join('\n');
    return `Added! Your cart:\n\n${summary}\n\n*Subtotal: Rs.${subtotal.toLocaleString()}*\n\nReply:\n1. Add more products\n2. Proceed to checkout`;
  }

  // ADD MORE OR CHECKOUT
  if (state === 'add_more') {
    if (text === '1' || lower.includes('more') || lower.includes('add')) {
      const products = db.getProducts(domain);
      const list = products.map((p,i)=>`${i+1}. *${p.name}* — Rs.${Math.min(...(p.variants||[]).map(v=>v.price)||[0]).toLocaleString()}+`).join('\n');
      db.updateContactState(domain, phone, 'selecting_product', cart, { ...temp, products });
      return `Choose another product:\n\n${list}`;
    }
    db.updateContactState(domain, phone, 'collecting_name', cart, temp);
    return `Let's confirm your order.\n\nStep 1/4: What is your *full name*?`;
  }

  // COLLECTING DETAILS
  if (state === 'collecting_name') {
    if (text.length < 2) return `Please enter your full name.`;
    db.updateContactState(domain, phone, 'collecting_address', cart, { ...temp, name: text });
    return `Step 2/4: What is your *delivery address*? (House no, street, city)`;
  }
  if (state === 'collecting_address') {
    if (text.length < 5) return `Please enter your full delivery address.`;
    db.updateContactState(domain, phone, 'collecting_phone', cart, { ...temp, address: text });
    return `Step 3/4: What is your *contact number*?`;
  }
  if (state === 'collecting_phone') {
    if (text.replace(/\s/g,'').length < 9) return `Please enter a valid phone number.`;
    db.updateContactState(domain, phone, 'collecting_payment', cart, { ...temp, contact: text });
    return `Step 4/4: Choose *payment method*:\n\n1. Cash on Delivery (COD)\n2. Bank Transfer\n3. Koko\n4. Mintpay`;
  }
  if (state === 'collecting_payment') {
    const pMap = {'1':'cod','2':'bank_transfer','3':'koko','4':'mintpay','cod':'cod','bank':'bank_transfer','koko':'koko','mintpay':'mintpay'};
    const payment = pMap[lower] || pMap[text];
    if (!payment) return `Please reply 1, 2, 3, or 4.`;
    db.updateContactState(domain, phone, 'confirming', cart, { ...temp, payment });
    const summary = cart.map(i=>`• ${i.product_name} (${i.variant}) x${i.qty} — Rs.${(i.price*i.qty).toLocaleString()}`).join('\n');
    const subtotal = cart.reduce((s,i)=>s+i.price*i.qty, 0);
    return `📋 *Order Summary*\n\n${summary}\n\nSubtotal: Rs.${subtotal.toLocaleString()}\nShipping: Rs.${SHIPPING}\n*Total: Rs.${(subtotal+SHIPPING).toLocaleString()}*\n\n👤 ${temp.name}\n📍 ${temp.address}\n📞 ${temp.contact}\n💳 ${PAYMENT_LABELS[payment]}\n\nReply *YES* to confirm or *EDIT* to change.`;
  }

  // CONFIRMING
  if (state === 'confirming') {
    if (lower === 'edit' || lower.includes('change')) {
      db.updateContactState(domain, phone, 'collecting_name', cart, {});
      return `No problem! Let's redo the details.\n\nStep 1/4: Your *full name*?`;
    }
    if (['yes','confirm','ok','හරි','ඔව්'].includes(lower)) {
      const subtotal = cart.reduce((s,i)=>s+i.price*i.qty, 0);
      const order_number = `WA-${Date.now().toString().slice(-5)}`;
      const order = db.createWAOrder(domain, { ...temp, cart, subtotal, total: subtotal + SHIPPING, order_number });
      db.updateContactState(domain, phone, 'idle', [], {});
      const bankInfo = temp.payment === 'bank_transfer' ? `\n\n🏦 Bank: Commercial Bank\nAcc: 1234567890\nRef: ${order_number}` : '';
      return `✅ *Order Confirmed!*\n\nOrder *#${order_number}*\n*Total: Rs.${(subtotal+SHIPPING).toLocaleString()}*${bankInfo}\n\nWe'll notify you when it's packed. Thank you! 🙏`;
    }
    return `Reply *YES* to confirm or *EDIT* to change details.`;
  }

  return null;
}

module.exports = { handleOrderFlow };
