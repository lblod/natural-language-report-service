// Maps the 'mu' import to dev-stubs/mu-stub.mjs, so tests run without the
// template container.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'mu') {
    return { shortCircuit: true, url: new URL('./mu-stub.mjs', import.meta.url).href };
  }
  return nextResolve(specifier, context);
}
