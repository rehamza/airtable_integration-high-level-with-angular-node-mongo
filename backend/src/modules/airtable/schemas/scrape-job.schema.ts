import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { Integration } from '../../integrations/schemas/integration.schema';

export type ScrapeJobDocument = HydratedDocument<ScrapeJob>;

@Schema({ _id: false, versionKey: false })
export class ScrapeJobError {
  @Prop({ required: true })
  message!: string;

  @Prop({ required: true, default: () => new Date() })
  at!: Date;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  details!: Record<string, unknown>;
}

@Schema({
  collection: 'scrape_jobs',
  timestamps: true,
  versionKey: false,
})
export class ScrapeJob {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: Integration.name,
    required: true,
    index: true,
  })
  integrationId!: Types.ObjectId;

  @Prop({
    required: true,
    trim: true,
    lowercase: true,
    enum: ['revision_history', 'cookie_validation', 'session_login'],
  })
  jobType!: string;

  @Prop({
    required: true,
    trim: true,
    lowercase: true,
    enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
    default: 'queued',
  })
  status!: string;

  @Prop({
    trim: true,
    lowercase: true,
    enum: ['integration', 'base', 'table', 'record'],
  })
  targetEntity?: string;

  @Prop({ trim: true })
  targetId?: string;

  @Prop({ trim: true })
  baseId?: string;

  @Prop({ trim: true })
  tableId?: string;

  @Prop({ trim: true })
  recordId?: string;

  @Prop({ required: true, default: () => new Date() })
  queuedAt!: Date;

  @Prop()
  startedAt?: Date;

  @Prop()
  finishedAt?: Date;

  @Prop()
  lastHeartbeatAt?: Date;

  @Prop({ default: 0 })
  attempt!: number;

  @Prop({ default: 3 })
  maxAttempts!: number;

  @Prop({ default: 0 })
  recordsProcessed!: number;

  @Prop({ default: 0 })
  recordsTotal!: number;

  @Prop()
  lastError?: string;

  @Prop({ type: [ScrapeJobError], default: [] })
  errorHistory!: ScrapeJobError[];

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  filters!: Record<string, unknown>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  metadata!: Record<string, unknown>;
}

export const ScrapeJobSchema = SchemaFactory.createForClass(ScrapeJob);

ScrapeJobSchema.index({ integrationId: 1, status: 1, queuedAt: 1 });
ScrapeJobSchema.index({ integrationId: 1, jobType: 1, status: 1 });
