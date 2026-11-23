"use strict";
import assert from "node:assert/strict";
import {createPaymentCallback} from "../api/payu-callback.mjs";
import {checkoutFields,hash} from "../lib/checkout.mjs";
const merchant={key:"unit-test-merchant",salt:"unit-test-salt",paymentUrl:"https://test.payu.in/_payment"};
const order={
 id:"AM1234567890ABCDEF",payAmount:499,paymentMethod:"prepaid",status:"pending",
 customer:{name:"Example Customer",email:"sample@example.com",phone:"9876543210"}
};
function validCallback(status="success"){
 const fields={...checkoutFields(order,merchant,"https://store.example").fields,status};
 delete fields.hash;
 fields.hash=hash([merchant.salt,status,"","","","","",fields.udf5,fields.udf4,fields.udf3,fields.udf2,fields.udf1,
  fields.email,fields.firstname,fields.productinfo,fields.amount,fields.txnid,merchant.key].join("|"));
 return fields;
}
const request=(fields,webhook=true)=>new Request("https://store.example/api/payu-callback"+(webhook?"?webhook=1":""),
 {method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(fields)});
function handler(reconcile){
 return createPaymentCallback({merchantProvider:()=>merchant,orderFinder:async id=>id===order.id?order:null,
  orderReconciler:reconcile});
}
const paid=handler(async()=>({...order,status:"paid"}));
let response=await paid(request(validCallback()));
assert.equal(response.status,200);
assert.deepEqual(await response.json(),{received:true,verified:true});
response=await paid(request(validCallback("failure")));
assert.equal(response.status,200,"Independent PayU result, not callback text, controls status");
const pending=handler(async()=>({...order,status:"pending"}));
response=await pending(request(validCallback()));
assert.equal(response.status,503,"Webhook should be retried if PayU has not confirmed payment");
assert.equal(response.headers.get("retry-after"),"30");
assert.deepEqual(await response.json(),{received:false,retry:true});
const unavailable=handler(async()=>{throw Error("PayU verification temporarily unavailable")});
response=await unavailable(request(validCallback()));
assert.equal(response.status,503,"Do not acknowledge a webhook if verification fails");
response=await pending(request(validCallback(),false));
assert.equal(response.status,303,"Browser should see status page even while verification is pending");
assert.equal(response.headers.get("location"),"/order-status?txnid="+order.id);
response=await unavailable(request(validCallback(),false));
assert.equal(response.status,303,"Browser should get a pending status page instead of a raw server error");
response=await paid(request({...validCallback(),hash:"0".repeat(128)}));
assert.equal(response.status,400,"Forged callbacks must never be accepted");
response=await paid(request({...validCallback(),amount:"1.00"}));
assert.equal(response.status,400,"Amount tampering must fail signature validation");
console.log("PASS: PayU callback validates hashes, retries unconfirmed webhooks, acknowledges verified states and redirects browser safely.");
