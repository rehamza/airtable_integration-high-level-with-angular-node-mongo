import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { Integration } from '../../integrations/schemas/integration.schema';

export type AirtableBaseDocument = HydratedDocument<AirtableBase>;

@Schema({
  collection: 'airtable_bases',
  timestamps: true,
  versionKey: false,
})
export class AirtableBase {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: Integration.name,
    required: true,
    index: true,
  })
  integrationId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  baseId!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true })
  permissionLevel?: string;

  @Prop({ trim: true })
  workspaceId?: string;

  @Prop({ trim: true })
  workspaceName?: string;

  @Prop({ default: false })
  isDeleted!: boolean;

  @Prop()
  syncedAt?: Date;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  raw!: Record<string, unknown>;
}

export const AirtableBaseSchema = SchemaFactory.createForClass(AirtableBase);

AirtableBaseSchema.index({ integrationId: 1, baseId: 1 }, { unique: true });
AirtableBaseSchema.index({ integrationId: 1, name: 1 });
