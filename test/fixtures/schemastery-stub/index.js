/**
 * Minimal stand-in for @deepseek-ai/schemastery, used only by the host-side
 * regression test. The real package lives in the DSH profile; the plugin itself
 * has zero runtime dependencies, so the test copies index.js into a temp dir and
 * satisfies this one import from here instead of reaching into a profile.
 *
 * Config is exported for the host to validate; apply() only reads fields off the
 * plain object the test passes, so a chainable stub is enough.
 */
function field(kind, inner) {
  return {
    kind: kind,
    inner: inner,
    default(value) { return { kind: kind, inner: inner, defaultValue: value } },
  }
}

const z = {
  object(shape) { return { kind: 'object', shape: shape } },
  boolean() { return field('boolean') },
  string() { return field('string') },
  array(inner) { return field('array', inner) },
}

export default z
