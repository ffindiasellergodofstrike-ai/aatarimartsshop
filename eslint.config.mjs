import firebaseRulesPlugin from "@firebase/eslint-plugin-security-rules";

export default [
  {
    ignores: ["publish/**", "dist-private/**", "node_modules/**", "media/**", "data/**"],
  },
  {
    files: ["**/*.rules"],
    ...firebaseRulesPlugin.configs["flat/recommended"],
  },
];
