import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AirtableBase, AirtableBaseSchema } from '../airtable/schemas/airtable-base.schema';
import { AirtablePage, AirtablePageSchema } from '../airtable/schemas/airtable-page.schema';
import {
  AirtableRevisionHistory,
  AirtableRevisionHistorySchema,
} from '../airtable/schemas/airtable-revision-history.schema';
import { AirtableTable, AirtableTableSchema } from '../airtable/schemas/airtable-table.schema';
import { AirtableUser, AirtableUserSchema } from '../airtable/schemas/airtable-user.schema';
import { IntegrationsModule } from '../integrations/integrations.module';
import { GridController } from './grid.controller';
import { GridService } from './grid.service';

@Module({
  imports: [
    IntegrationsModule,
    MongooseModule.forFeature([
      { name: AirtableBase.name, schema: AirtableBaseSchema },
      { name: AirtableTable.name, schema: AirtableTableSchema },
      { name: AirtablePage.name, schema: AirtablePageSchema },
      { name: AirtableUser.name, schema: AirtableUserSchema },
      { name: AirtableRevisionHistory.name, schema: AirtableRevisionHistorySchema },
    ]),
  ],
  controllers: [GridController],
  providers: [GridService],
  exports: [GridService],
})
export class GridModule {}
