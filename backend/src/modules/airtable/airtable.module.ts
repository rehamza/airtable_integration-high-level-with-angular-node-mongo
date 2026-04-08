import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { IntegrationsModule } from '../integrations/integrations.module';
import { AirtableIntegrationsController } from './controllers/airtable-integrations.controller';
import { AirtableBase, AirtableBaseSchema } from './schemas/airtable-base.schema';
import { AirtablePage, AirtablePageSchema } from './schemas/airtable-page.schema';
import {
  AirtableRevisionHistory,
  AirtableRevisionHistorySchema,
} from './schemas/airtable-revision-history.schema';
import { AirtableTable, AirtableTableSchema } from './schemas/airtable-table.schema';
import { AirtableUser, AirtableUserSchema } from './schemas/airtable-user.schema';
import { ScrapeJob, ScrapeJobSchema } from './schemas/scrape-job.schema';
import { AirtableOAuthService } from './services/airtable-oauth.service';

@Module({
  imports: [
    IntegrationsModule,
    MongooseModule.forFeature([
      {
        name: AirtableBase.name,
        schema: AirtableBaseSchema,
      },
      {
        name: AirtableTable.name,
        schema: AirtableTableSchema,
      },
      {
        name: AirtablePage.name,
        schema: AirtablePageSchema,
      },
      {
        name: AirtableUser.name,
        schema: AirtableUserSchema,
      },
      {
        name: AirtableRevisionHistory.name,
        schema: AirtableRevisionHistorySchema,
      },
      {
        name: ScrapeJob.name,
        schema: ScrapeJobSchema,
      },
    ]),
  ],
  controllers: [AirtableIntegrationsController],
  providers: [AirtableOAuthService],
  exports: [MongooseModule, AirtableOAuthService],
})
export class AirtableModule {}
