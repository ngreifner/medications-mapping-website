import assert from "node:assert/strict";
import { getWhoName, isCombinationCode, listCombinationL5sInL4 } from "./who-full-index.mjs";

// names come from WHO's published index
assert.equal(getWhoName("N01BB52"), "lidocaine, combinations");
assert.equal(getWhoName("N01BB02"), "lidocaine");

// combination detection is name-driven, not prefix-driven
assert.equal(isCombinationCode("N01BB52"), true);   // ", combinations"
assert.equal(isCombinationCode("N02AJ22"), true);   // "hydrocodone and paracetamol"
assert.equal(isCombinationCode("J05AP57"), true);   // "glecaprevir and pibrentasvir"
assert.equal(isCombinationCode("N01BB02"), false);  // plain substance
assert.equal(isCombinationCode("A10AB05"), false);  // plain substance

// low-index combination codes are caught by name even though index < 50
assert.equal(isCombinationCode("J01CR02"), true);   // "amoxicillin and beta-lactamase inhibitor"
assert.equal(isCombinationCode("N04BA02"), true);   // "levodopa and decarboxylase inhibitor"

// enumerating a class
const combos = listCombinationL5sInL4("N01BB");
assert.ok(combos.includes("N01BB52"));
assert.ok(!combos.includes("N01BB02"));

console.log("who-full-index: all assertions passed");
