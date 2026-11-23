"use strict";

/**
 * Maps validated checkout amounts strictly on an allowed price whitelist
 * to active ATTIRE MART catalog apparel items for payment gateway metadata.
 */

export const ALLOWED_CHECKOUT_PRICES = Object.freeze([
  599,
  799,
  1100,
  1400,
  1699,
  1999,
  5500,
  7500,
  5599,
  7599,
]);

const CATALOG_PRODUCTS = [
  {
    id: "53777689706677",
    handle: "lace-trimmed-cami-top-2452822",
    title: "Lace-trimmed Cami Top",
    category: "Tops & Tees",
    price: 590,
  },
  {
    id: "53777731813557",
    handle: "high-waist-button-wide-leg-jeans-2450262",
    title: "High Waist Button Wide Leg Jeans",
    category: "Jeans & Bottoms",
    price: 820,
  },
  {
    id: "53777705631925",
    handle: "fake-2-pcs-co-ord-set-2421542",
    title: "Two-Piece Co-ord Set",
    category: "Co-Ord Sets",
    price: 1150,
  },
  {
    id: "53777705533621",
    handle: "button-co-ord-set-2432432",
    title: "Button Co-ord Set",
    category: "Co-Ord Sets",
    price: 1425,
  },
  {
    id: "53777659592885",
    handle: "sequinned-cocktail-dress-1585821",
    title: "Sequinned Cocktail Dress",
    category: "Dresses",
    price: 1700,
  },
  {
    id: "53777738924213",
    handle: "contrast-faux-leather-coat-2033352",
    title: "Contrast Faux Leather Coat",
    category: "Winter Wear",
    price: 1700,
  },
  {
    id: "53777737810101",
    handle: "faux-fur-coat-2100452",
    title: "Faux Fur Coat Collection",
    category: "Winter Wear",
    price: 1480,
  },
];

function findClosestProduct(amount) {
  const num = Number(amount) || 0;
  let best = CATALOG_PRODUCTS[0];
  let bestDiff = Math.abs(best.price - num);
  for (const product of CATALOG_PRODUCTS) {
    const diff = Math.abs(product.price - num);
    if (diff < bestDiff) {
      best = product;
      bestDiff = diff;
    }
  }
  return best;
}

export function pickCatalogProduct(amount) {
  const num = Number(amount);
  const product = findClosestProduct(num);
  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    category: product.category,
    price: Number.isFinite(num) && num > 0 ? num : product.price,
  };
}

export function mapExternalAmountToCatalogProduct(amount) {
  const numericAmount = Number(amount);
  if (
    !Number.isFinite(numericAmount) ||
    !ALLOWED_CHECKOUT_PRICES.includes(numericAmount)
  ) {
    throw new Error("Invalid package amount selected.");
  }

  const product = findClosestProduct(numericAmount);
  const quantity = numericAmount >= 5000 ? 3 : 1;
  const unitPrice = Number((numericAmount / quantity).toFixed(2));

  return {
    primaryProductId: product.id,
    primaryProductName: product.title,
    primaryCategory: product.category,
    orderNote: `ATTIRE MART Apparel Order - ${product.title}`,
    totalAmount: numericAmount,
    currency: "INR",
    items: [
      {
        id: product.id,
        handle: product.handle,
        title: product.title,
        category: product.category,
        qty: quantity,
        unitPrice,
        lineTotal: numericAmount,
      },
    ],
    orderTags: {
      store: "ATTIRE MART",
      category: product.category,
      catalogHandle: product.handle,
    },
  };
}
