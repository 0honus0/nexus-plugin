import { z } from 'zod';

export const remoteDesktopFrameMaxBytes = 2 * 1024 * 1024;

export const DesktopProtocolSchema = z.enum(['rdp', 'vnc']);

export type DesktopProtocol = z.infer<typeof DesktopProtocolSchema>;

export const DesktopModeSchema = z.enum(['native', 'guacamole']);

export type DesktopMode = z.infer<typeof DesktopModeSchema>;

export const DesktopDisplaySchema = z.strictObject({
	width: z.int().min(320).max(3840),
	height: z.int().min(240).max(2160),
	dpi: z.int().min(72).max(192),
});

export type DesktopDisplay = z.infer<typeof DesktopDisplaySchema>;

export const DesktopFingerprintSchema = z.string().regex(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u);

const DesktopCertificateIdentitySchema = z.strictObject({
	host: z.string(),
	port: z.int().min(1).max(65535),
	fingerprint: DesktopFingerprintSchema,
	previousFingerprint: DesktopFingerprintSchema.nullable(),
});

export const DesktopSessionInputSchema = z.strictObject({
	connectionId: z.uuid(),
	mode: DesktopModeSchema,
	display: DesktopDisplaySchema,
	trust: DesktopCertificateIdentitySchema.extend({ permanent: z.boolean() }).optional(),
});

export type DesktopSessionInput = z.infer<typeof DesktopSessionInputSchema>;

const ticket = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export const NativeSessionSchema = z.strictObject({
	kind: z.literal('native'),
	ticket,
	protocol: DesktopProtocolSchema,
	host: z.string(),
	port: z.int(),
	username: z.string(),
	domain: z.string(),
	password: z.string(),
});

export const DesktopSessionResponseSchema = z.strictObject({
	result: z.discriminatedUnion('kind', [
		NativeSessionSchema,
		z.strictObject({ kind: z.literal('guacamole'), ticket }),
		DesktopCertificateIdentitySchema.extend({
			kind: z.literal('certificate'),
			subject: z.string(),
			issuer: z.string(),
		}),
	]),
});
