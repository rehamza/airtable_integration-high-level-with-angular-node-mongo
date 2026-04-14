import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { Integration } from '../../integrations/schemas/integration.schema';

export type AirtableRevisionHistoryDocument = HydratedDocument<AirtableRevisionHistory>;

@Schema({ _id: false, versionKey: false })
export class RevisionActor {
  @Prop({ trim: true })
  userId?: string;

  @Prop({ trim: true })
  name?: string;

  @Prop({ trim: true, lowercase: true })
  email?: string;
}

@Schema({
  collection: 'airtable_revision_history',
  timestamps: true,
  versionKey: false,
})
export class AirtableRevisionHistory {
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

  @Prop({ required: true, trim: true, index: true })
  recordId!: string;

  @Prop({ trim: true, index: true })
  activityId?: string;

  @Prop({ required: true, trim: true, index: true })
  uuid!: string;

  @Prop({ required: true, trim: true, index: true })
  issueId!: string;

  @Prop({
    required: true,
    trim: true,
    lowercase: true,
  })
  changeType!: string;

  @Prop({ required: true, trim: true, lowercase: true })
  columnType!: string;

  @Prop({ required: true, trim: true })
  fieldName!: string;

  @Prop({ trim: true })
  columnId?: string;

  @Prop({ trim: true, lowercase: true })
  groupType?: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  oldValue?: unknown;

  @Prop({ type: MongooseSchema.Types.Mixed })
  newValue?: unknown;

  @Prop({ required: true })
  changedAt!: Date;

  @Prop({ required: true })
  createdDate!: Date;

  @Prop({ type: RevisionActor, default: {} })
  changedBy!: RevisionActor;

  @Prop({ trim: true })
  authoredBy?: string;

  @Prop({ required: true, trim: true })
  dedupeKey!: string;

  @Prop({ trim: true })
  sourceUrl?: string;

  @Prop()
  syncedAt?: Date;

  @Prop()
  rawHtmlSnippet?: string;
}

export const AirtableRevisionHistorySchema = SchemaFactory.createForClass(AirtableRevisionHistory);

AirtableRevisionHistorySchema.index({ dedupeKey: 1 }, { unique: true });
AirtableRevisionHistorySchema.index({ uuid: 1 }, { unique: true });
AirtableRevisionHistorySchema.index({ integrationId: 1, recordId: 1, changedAt: -1 });
AirtableRevisionHistorySchema.index({ integrationId: 1, changeType: 1, changedAt: -1 });
