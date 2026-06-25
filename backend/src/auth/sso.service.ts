import passport from "passport";
import { Strategy as GoogleStrategy, type Profile as GoogleProfile } from "passport-google-oauth20";
import { Strategy as MicrosoftStrategy } from "passport-microsoft";
import type { PoolClient } from "pg";
import { config } from "../config.js";
import { AuditAction } from "../audit/actions.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { normalizeEmail } from "./crypto.utils.js";

export interface SsoProfile {
  provider: "google" | "microsoft";
  providerUserId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  raw: Record<string, unknown>;
}

export function configurePassport(): void {
  const googleId = config.googleClientId();
  const googleSecret = config.googleClientSecret();
  if (googleId && googleSecret) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: googleId,
          clientSecret: googleSecret,
          callbackURL: config.googleCallbackUrl(),
        },
        (_accessToken, _refreshToken, profile, done) => {
          done(null, mapGoogleProfile(profile));
        }
      )
    );
  }

  const msId = config.microsoftClientId();
  const msSecret = config.microsoftClientSecret();
  if (msId && msSecret) {
    passport.use(
      new MicrosoftStrategy(
        {
          clientID: msId,
          clientSecret: msSecret,
          callbackURL: config.microsoftCallbackUrl(),
          tenant: config.microsoftTenantId(),
          scope: ["user.read"],
        },
        (_accessToken, _refreshToken, profile, done) => {
          done(null, mapMicrosoftProfile(profile));
        }
      )
    );
  }
}

function mapGoogleProfile(profile: GoogleProfile): SsoProfile {
  const email = profile.emails?.[0]?.value ?? "";
  return {
    provider: "google",
    providerUserId: profile.id,
    email: normalizeEmail(email),
    firstName: profile.name?.givenName,
    lastName: profile.name?.familyName,
    raw: profile._json as Record<string, unknown>,
  };
}

function mapMicrosoftProfile(profile: passport.Profile): SsoProfile {
  const email = (profile.emails?.[0]?.value ?? profile.username ?? "") as string;
  return {
    provider: "microsoft",
    providerUserId: profile.id,
    email: normalizeEmail(email),
    firstName: profile.name?.givenName,
    lastName: profile.name?.familyName,
    raw: (profile as { _json?: Record<string, unknown> })._json ?? {},
  };
}

export async function findUserBySsoIdentity(
  client: PoolClient,
  provider: "google" | "microsoft",
  providerUserId: string
) {
  const result = await client.query<{
    user_id: number;
    email: string;
    account_id: number;
    role_id: number;
    status: string;
  }>(
    `
    SELECT u.id AS user_id, u.email, u.account_id, u.role_id, u.status
    FROM user_oauth_identities o
    JOIN users u ON u.id = o.user_id
    WHERE o.provider = $1 AND o.provider_user_id = $2
    `,
    [provider, providerUserId]
  );
  return result.rows[0] ?? null;
}

export async function linkSsoIdentity(
  client: PoolClient,
  userId: number,
  profile: SsoProfile,
  meta: { ipAddress?: string; userAgent?: string; accountId?: number }
): Promise<void> {
  await client.query(
    `
    INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, provider_email, profile)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (provider, provider_user_id) DO UPDATE
    SET provider_email = EXCLUDED.provider_email,
        profile = EXCLUDED.profile,
        updated_at = NOW()
    `,
    [userId, profile.provider, profile.providerUserId, profile.email, JSON.stringify(profile.raw)]
  );

  await writeAuditLog(client, {
    actingUserId: userId,
    accountId: meta.accountId ?? null,
    action: AuditAction.SSO_LINKED,
    newValue: { provider: profile.provider, email: profile.email },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
}
