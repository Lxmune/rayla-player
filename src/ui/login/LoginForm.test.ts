import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../settings/test-app';
import LoginForm from './LoginForm.svelte';

afterEach(cleanup);

describe('LoginForm', () => {
  it('toggles password visibility', async () => {
    const { context } = buildApp();
    render(LoginForm, { context });
    const pw = screen.getByLabelText('Password') as HTMLInputElement;
    expect(pw.type).toBe('password');
    await fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(pw.type).toBe('text');
    await fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(pw.type).toBe('password');
  });

  it('hints the assumed scheme and validates required fields', async () => {
    const { context } = buildApp();
    render(LoginForm, { context });
    await fireEvent.input(screen.getByLabelText('Server address'), { target: { value: 'jf.test' } });
    expect(screen.getByText('http://jf.test')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Enter the server address/);
  });
});
