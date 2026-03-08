// Sample file for find/replace E2E tests
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export function farewell(name: string): string {
  return `Goodbye, ${name}!`;
}

// This file contains multiple occurrences of the word "name"
// to test find match counting and navigation.
const _defaultName = 'World';
const _anotherName = 'Clubhouse';
