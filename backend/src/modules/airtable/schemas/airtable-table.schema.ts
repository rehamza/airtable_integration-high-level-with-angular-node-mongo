import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { Integration } from '../../integrations/schemas/integration.schema';

export type AirtableTableDocument = HydratedDocument<AirtableTable>;

@Schema({ _id: false, versionKey: false })
export class AirtableTableField {
  @Prop({ required: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, trim: true })
  type!: string;

  @Prop({ default: false })
  isPrimary!: boolean;

  @Prop({ default: false })
  isComputed!: boolean;

  @Prop()
  description?: string;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  options!: Record<string, unknown>;
}

@Schema({ _id: false, versionKey: false })
export class AirtableTableView {
  @Prop({ required: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true })
  type?: string;

  @Prop({ default: false })
  personalForViewer!: boolean;
}

@Schema({
  collection: 'airtable_tables',
  timestamps: true,
  versionKey: false,
})
export class AirtableTable {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: Integration.name,
    required: true,
    index: true,
  })
  integrationId!: Types.ObjectId;

  @Prop({ required: true, trim: true, index: true })
  baseId!: string;

  @Prop({ required: true, trim: true })
  tableId!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true })
  description?: string;

  @Prop({ trim: true })
  primaryFieldId?: string;

  @Prop({ type: [AirtableTableField], default: [] })
  fields!: AirtableTableField[];

  @Prop({ type: [AirtableTableView], default: [] })
  views!: AirtableTableView[];

  @Prop()
  syncedAt?: Date;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  raw!: Record<string, unknown>;
}

export const AirtableTableSchema = SchemaFactory.createForClass(AirtableTable);

AirtableTableSchema.index({ integrationId: 1, baseId: 1, tableId: 1 }, { unique: true });
AirtableTableSchema.index({ integrationId: 1, baseId: 1, name: 1 });
