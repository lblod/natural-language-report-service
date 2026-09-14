// node --import ./dev-stubs/register.js <test file>
// Registers the 'mu' resolve hook (mu-hooks.mjs -> mu-stub.mjs).
import { register } from 'node:module';

register(new URL('./mu-hooks.mjs', import.meta.url).href);
