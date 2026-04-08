import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type IntegrationDocument = HydratedDocument<Integration>;

@Schema({ _id: false, versionKey: false })
export class IntegrationOAuthState {
  @Prop({ trim: true })
  accessToken?: string;

  @Prop({ trim: true })
  refreshToken?: string;

  @Prop({ trim: true })
  tokenType?: string;

  @Prop({ trim: true })
  scope?: string;

  @Prop()
  expiresAt?: Date;

  @Prop()
  lastRefreshedAt?: Date;
}

@Schema({ _id: false, versionKey: false })
export class IntegrationPkceState {
  @Prop({ trim: true })
  state?: string;

  @Prop({ trim: true })
  codeVerifier?: string;

  @Prop({ trim: true, default: 'S256' })
  codeChallengeMethod?: string;

  @Prop()
  expiresAt?: Date;
}

@Schema({ _id: false, versionKey: false })
export class BrowserCookie {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true })
  value!: string;

  @Prop({ trim: true })
  domain?: string;

  @Prop({ trim: true })
  path?: string;

  @Prop()
  expires?: number;

  @Prop({ default: false })
  httpOnly!: boolean;

  @Prop({ default: false })
  secure!: boolean;

  @Prop({ trim: true })
  sameSite?: string;
}

@Schema({
  collection: 'integrations',
  timestamps: true,
  versionKey: false,
})
export class Integration {
  @Prop({ required: true, trim: true, lowercase: true, enum: ['airtable'] })
  provider!: string;

  @Prop({ required: true, trim: true })
  integrationKey!: string;

  @Prop({ required: true, trim: true })
  displayName!: string;

  @Prop({
    required: true,
    trim: true,
    lowercase: true,
    enum: ['oauth', 'session'],
    default: 'oauth',
  })
  authType!: string;

  @Prop({
    required: true,
    trim: true,
    lowercase: true,
    enum: ['pending', 'active', 'inactive', 'error'],
    default: 'pending',
  })
  status!: string;

  @Prop({ type: [String], default: [] })
  scopes!: string[];

  @Prop({ default: true })
  isEnabled!: boolean;

  @Prop({ type: IntegrationOAuthState, default: {} })
  oauth!: IntegrationOAuthState;

  @Prop({ type: IntegrationPkceState, default: {} })
  pkce!: IntegrationPkceState;

  @Prop({ type: [BrowserCookie], default: [] })
  sessionCookies!: BrowserCookie[];

  @Prop()
  cookieExpiresAt?: Date;

  @Prop()
  lastSyncedAt?: Date;

  @Prop()
  connectedAt?: Date;

  @Prop({
    trim: true,
    lowercase: true,
    enum: ['idle', 'running', 'success', 'failed'],
    default: 'idle',
  })
  lastSyncStatus!: string;

  @Prop()
  lastSyncError?: string;

  @Prop()
  lastAuthError?: string;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  metadata!: Record<string, unknown>;
}

export const IntegrationSchema = SchemaFactory.createForClass(Integration);

IntegrationSchema.index({ provider: 1, integrationKey: 1 }, { unique: true });
IntegrationSchema.index({ status: 1, isEnabled: 1 });
IntegrationSchema.index({ 'pkce.state': 1 }, { sparse: true });
