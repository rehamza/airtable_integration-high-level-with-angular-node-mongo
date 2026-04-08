import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { Integration } from '../../integrations/schemas/integration.schema';

export type AirtableUserDocument = HydratedDocument<AirtableUser>;

@Schema({
  collection: 'airtable_users',
  timestamps: true,
  versionKey: false,
})
export class AirtableUser {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: Integration.name,
    required: true,
    index: true,
  })
  integrationId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  airtableUserId!: string;

  @Prop({ trim: true, lowercase: true })
  email?: string;

  @Prop({ trim: true })
  name?: string;

  @Prop({ trim: true })
  firstName?: string;

  @Prop({ trim: true })
  lastName?: string;

  @Prop({ trim: true })
  role?: string;

  @Prop({ trim: true })
  locale?: string;

  @Prop({ trim: true })
  timezone?: string;

  @Prop({ default: false })
  isDeleted!: boolean;

  @Prop()
  lastSeenAt?: Date;

  @Prop()
  syncedAt?: Date;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  raw!: Record<string, unknown>;
}

export const AirtableUserSchema = SchemaFactory.createForClass(AirtableUser);

AirtableUserSchema.index({ integrationId: 1, airtableUserId: 1 }, { unique: true });
AirtableUserSchema.index({ integrationId: 1, email: 1 });
