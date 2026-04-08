import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { Integration } from '../../integrations/schemas/integration.schema';

export type AirtablePageDocument = HydratedDocument<AirtablePage>;

@Schema({
  collection: 'airtable_pages',
  timestamps: true,
  versionKey: false,
})
export class AirtablePage {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: Integration.name,
    required: true,
    index: true,
  })
  integrationId!: Types.ObjectId;

  @Prop({ required: true, trim: true, index: true })
  baseId!: string;

  @Prop({ required: true, trim: true, index: true })
  tableId!: string;

  @Prop({ trim: true })
  tableName?: string;

  @Prop({ required: true, trim: true })
  recordId!: string;

  @Prop()
  createdTime?: Date;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  fields!: Record<string, unknown>;

  @Prop({ default: 0 })
  commentCount!: number;

  @Prop()
  syncedAt?: Date;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  raw!: Record<string, unknown>;
}

export const AirtablePageSchema = SchemaFactory.createForClass(AirtablePage);

AirtablePageSchema.index({ integrationId: 1, baseId: 1, tableId: 1, recordId: 1 }, { unique: true });
AirtablePageSchema.index({ integrationId: 1, tableId: 1, createdTime: -1 });
