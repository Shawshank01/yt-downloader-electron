/** Secrets shorter than this are not masked: they would also match ordinary words in messages. */
const MIN_SECRET_LENGTH = 6;

/** Replace every occurrence of any of `secrets` in `text` with `***`. */
export function redactSecrets(text, secrets = []) {
    let out = String(text ?? '');
    const candidates = secrets
        .filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH)
        .sort((a, b) => b.length - a.length); // longest first so a key that contains another is fully masked
    for (const secret of candidates) out = out.split(secret).join('***');
    return out;
}
