export const registrationModes = ["closed", "request", "open"] as const;
export const userStatuses = ["pending", "active", "disabled", "deleted"] as const;
export const roles = ["owner", "admin", "maintainer", "author", "user"] as const;

export type RegistrationMode = (typeof registrationModes)[number];
export type UserStatus = (typeof userStatuses)[number];
export type Role = (typeof roles)[number];

export interface AuthenticatedUser {
  id: string;
  email: string;
  status: UserStatus;
  roles: Role[];
  mfaVerified: boolean;
}

export function hasRole(user: Pick<AuthenticatedUser, "roles">, role: Role): boolean {
  return user.roles.includes(role);
}

export function canAdmin(user: AuthenticatedUser): boolean {
  return user.status === "active" && user.mfaVerified && (hasRole(user, "owner") || hasRole(user, "admin"));
}

export function canAuthor(user: AuthenticatedUser): boolean {
  return user.status === "active" && (hasRole(user, "author") || hasRole(user, "maintainer") || canAdmin(user));
}

