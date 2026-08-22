export const MIN_PASSWORD_LENGTH = 8;

export const passwordValid = (password: string, confirmation: string): boolean =>
  password === '' || (password.length >= MIN_PASSWORD_LENGTH && password === confirmation);
