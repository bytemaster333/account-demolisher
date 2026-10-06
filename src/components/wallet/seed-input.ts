// attributes for every field that takes a secret seed. browsers ignore
// autocomplete="off" on password fields, so the field is marked as a one-time
// code (not saved by built-in managers) and the common password-manager
// extensions are told to skip it.
export const SEED_INPUT_ATTRS = {
  type: "password",
  autoComplete: "one-time-code",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  "data-1p-ignore": "",
  "data-lpignore": "true",
  "data-bwignore": "",
  "data-form-type": "other",
} as const;
