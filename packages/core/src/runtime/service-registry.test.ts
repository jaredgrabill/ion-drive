import { describe, expect, it } from 'vitest';
import { ServiceRegistry, ServiceRegistryError, serviceToken } from './service-registry.js';

interface Greeter {
  greet(): string;
}

const GREETER = serviceToken<Greeter>('greeter');
const OTHER = serviceToken<Greeter>('other');

describe('ServiceRegistry', () => {
  it('stores and resolves an implementation by token', () => {
    const registry = new ServiceRegistry();
    registry.set(GREETER, { greet: () => 'hello' });

    expect(registry.get(GREETER)?.greet()).toBe('hello');
    expect(registry.has(GREETER)).toBe(true);
  });

  it('lets a later set replace an earlier one (plugin override — last write wins)', () => {
    const registry = new ServiceRegistry();
    registry.set(GREETER, { greet: () => 'default' });
    registry.set(GREETER, { greet: () => 'override' });

    expect(registry.require(GREETER).greet()).toBe('override');
  });

  it('returns undefined / false for an unregistered token', () => {
    const registry = new ServiceRegistry();
    expect(registry.get(GREETER)).toBeUndefined();
    expect(registry.has(GREETER)).toBe(false);
  });

  it('require throws for an unregistered token', () => {
    const registry = new ServiceRegistry();
    expect(() => registry.require(GREETER)).toThrow(ServiceRegistryError);
    expect(() => registry.require(GREETER)).toThrow(/greeter/);
  });

  it('lists registered keys', () => {
    const registry = new ServiceRegistry();
    registry.set(GREETER, { greet: () => 'a' }).set(OTHER, { greet: () => 'b' });
    expect(registry.registeredKeys()).toEqual(expect.arrayContaining(['greeter', 'other']));
  });
});
