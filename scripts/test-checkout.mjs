"use strict";
import assert from "node:assert/strict";
import fs from "node:fs";
import {createHash} from "node:crypto";
import {priceItems,validateCustomer,getMerchant,checkoutFields,callbackHashValid,
 newGuestOrderToken,hashGuestToken,guestTokenMatches,computeOrderReconciliationPatch,hash}
 from "../lib/checkout.mjs";
process.env.PAYU_ENV="test";
process.env.PAYU_MERCHANT_KEY="unit-test-merchant";
process.env.PAYU_MERCHANT_SALT="unit-test-salt";
const customer=validateCustomer({name:"Sample Customer",email:"sample@example.com",phone:"9876543210",
 address1:"18 Example Shopping Street",address2:"Near park",city:"Lucknow",state:"Uttar Pradesh",pincode:"226001"});
assert.equal(customer.country,"India");
assert.throws(()=>validateCustomer({...customer,phone:"12345"}));
const catalog=JSON.parse(fs.readFileSync("data/checkout-catalog.json","utf8"));
assert.equal(Object.keys(catalog.variants).length,878);
const one=Object.values(catalog.variants).find(x=>x.available&&Number(x.price)>0);
assert.ok(one);
const other=Object.values(catalog.variants).find(x=>x.handle===one.handle&&x.id!==one.id&&x.available);
const priced=priceItems([{id:one.id,qty:2}],"prepaid");
assert.equal(priced.total,2*one.price);
assert.throws(()=>priceItems([{id:one.id,qty:11}],"prepaid"));
assert.throws(()=>priceItems([{id:one.id,qty:1},{id:one.id,qty:1}],"prepaid"));
if(other){
 assert.throws(()=>priceItems([{id:one.id,qty:6},{id:other.id,qty:5}],"prepaid"),/Maximum 10/);
 assert.equal(priceItems([{id:one.id,qty:6},{id:other.id,qty:4}],"prepaid").items.length,2);
}
const cod=priceItems([{id:one.id,qty:2}],"cod");
assert.equal(cod.payAmount,Math.min(cod.total,cod.total<700?199:299));
assert.equal(priceItems([{id:one.id,qty:1,price:1}],"prepaid").total,one.price);
const token=newGuestOrderToken();assert.match(token,/^[a-f0-9]{64}$/);
assert.ok(guestTokenMatches(token,hashGuestToken(token)));
assert.equal(guestTokenMatches("0".repeat(64),hashGuestToken(token)),false);
const merchant=getMerchant();
const order={id:"AM1234567890ABCDEF",customer,paymentMethod:"prepaid",payAmount:priced.payAmount,status:"pending"};
const payment=checkoutFields(order,merchant,"https://shop.example.com");
assert.equal(payment.gateway,"https://test.payu.in/_payment");
assert.ok(!JSON.stringify(payment.fields).includes(merchant.salt));
const f=payment.fields;
const expected=hash([f.key,f.txnid,f.amount,f.productinfo,f.firstname,f.email,f.udf1,f.udf2,f.udf3,f.udf4,f.udf5,
 "","","","","",merchant.salt].join("|"));
assert.equal(f.hash,expected);
const callback={...f,status:"success"};delete callback.hash;
callback.hash=createHash("sha512").update([merchant.salt,"success","","","","","",
 callback.udf5,callback.udf4,callback.udf3,callback.udf2,callback.udf1,
 callback.email,callback.firstname,callback.productinfo,callback.amount,callback.txnid,merchant.key].join("|")).digest("hex");
assert.ok(callbackHashValid(callback,merchant));
assert.equal(callbackHashValid({...callback,amount:"1.00"},merchant),false);
assert.equal(callbackHashValid({...callback,status:"failure"},merchant),false);
const patch=computeOrderReconciliationPatch({...order,total:priced.total,balanceDue:0,fulfillmentStatus:"awaiting_payment"},{state:"success",unmapped:"captured",amount:priced.payAmount,txnId:order.id,payuId:"MOCK"});
assert.equal(patch.status,"paid");
assert.equal(computeOrderReconciliationPatch({...order,status:"paid"},{state:"failure",txnId:order.id,amount:priced.payAmount}),null);
console.log("PASS: merchant hash, callback validation, guest token, Firestore reconciliation, 878 prices and max 10 per product.");
