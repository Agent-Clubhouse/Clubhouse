import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';

type IpcEvent = IpcMainEvent | IpcMainInvokeEvent;
type IpcHandler<Args extends unknown[], Result> = (event: IpcEvent, ...args: Args) => Result;

export type ArgValidator<T> = (value: unknown, argName: string) => T;

function fail(argName: string, message: string): never {
  throw new Error(`${argName} ${message}`);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function stringArg(options: { minLength?: number; optional: true }): ArgValidator<string | undefined>;
export function stringArg(options?: { minLength?: number; optional?: false }): ArgValidator<string>;
export function stringArg(options: { minLength?: number; optional?: boolean } = {}): ArgValidator<string | undefined> {
  const { minLength = 1, optional = false } = options;

  return (value, argName) => {
    if (optional && value === undefined) return undefined;
    if (typeof value !== 'string') {
      fail(argName, `must be a string, received ${describeType(value)}`);
    }
    if (value.length < minLength) {
      fail(argName, `must be at least ${minLength} character${minLength === 1 ? '' : 's'}`);
    }
    return value;
  };
}

export function booleanArg(): ArgValidator<boolean> {
  return (value, argName) => {
    if (typeof value !== 'boolean') {
      fail(argName, `must be a boolean, received ${describeType(value)}`);
    }
    return value;
  };
}

export function numberArg(options: { integer?: boolean; min?: number; optional: true }): ArgValidator<number | undefined>;
export function numberArg(options?: { integer?: boolean; min?: number; optional?: false }): ArgValidator<number>;
export function numberArg(options: { integer?: boolean; min?: number; optional?: boolean } = {}): ArgValidator<number | undefined> {
  const { integer = false, min, optional = false } = options;

  return (value, argName) => {
    if (optional && value === undefined) return undefined;
    if (typeof value !== 'number' || Number.isNaN(value)) {
      fail(argName, `must be a number, received ${describeType(value)}`);
    }
    if (integer && !Number.isInteger(value)) {
      fail(argName, 'must be an integer');
    }
    if (min !== undefined && value < min) {
      fail(argName, `must be greater than or equal to ${min}`);
    }
    return value;
  };
}

export function arrayArg<T>(itemValidator: ArgValidator<T>, options: { optional: true }): ArgValidator<T[] | undefined>;
export function arrayArg<T>(itemValidator: ArgValidator<T>, options?: { optional?: false }): ArgValidator<T[]>;
export function arrayArg<T>(itemValidator: ArgValidator<T>, options: { optional?: boolean } = {}): ArgValidator<T[] | undefined> {
  const { optional = false } = options;

  return (value, argName) => {
    if (optional && value === undefined) return undefined;
    if (!Array.isArray(value)) {
      fail(argName, `must be an array, received ${describeType(value)}`);
    }
    return value.map((item, index) => itemValidator(item, `${argName}[${index}]`));
  };
}

export function objectArg<T extends object>(options: {
  optional: true;
  validate?: (value: T, argName: string) => void;
}): ArgValidator<T | undefined>;
export function objectArg<T extends object>(options?: {
  optional?: false;
  validate?: (value: T, argName: string) => void;
}): ArgValidator<T>;
export function objectArg<T extends object>(options: {
  optional?: boolean;
  validate?: (value: T, argName: string) => void;
} = {}): ArgValidator<T | undefined> {
  const { optional = false, validate } = options;

  return (value, argName) => {
    if (optional && value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail(argName, `must be an object, received ${describeType(value)}`);
    }
    const typedValue = value as T;
    validate?.(typedValue, argName);
    return typedValue;
  };
}

export function optional<T>(validator: ArgValidator<T>): ArgValidator<T | undefined> {
  return (value, argName) => (value === undefined ? undefined : validator(value, argName));
}

function validateArgs<Args extends unknown[]>(args: unknown[], validators: { [K in keyof Args]: ArgValidator<Args[K]> }): Args {
  return validators.map((validator, index) => validator(args[index], `arg${index + 1}`)) as Args;
}

export function withValidatedArgs<Args extends unknown[], Result>(
  validators: { [K in keyof Args]: ArgValidator<Args[K]> },
  handler: IpcHandler<Args, Result>,
): IpcHandler<Args, Result> {
  return (event, ...rawArgs) => {
    const args = validateArgs(rawArgs, validators);
    return handler(event, ...args);
  };
}
