import { Controller, Get, Param, Query } from '@nestjs/common';
import { AirtableCollectionQueryDto } from '../dto/airtable-collection-query.dto';
import { AirtableScrapeJobQueryDto } from '../dto/airtable-scrape-job-query.dto';
import { AirtableDataService } from '../services/airtable-data.service';

@Controller('integrations/airtable')
export class AirtableDataController {
  constructor(private readonly airtableDataService: AirtableDataService) {}

  @Get('endpoints')
  getEndpointCatalog() {
    return this.airtableDataService.getEndpointCatalog();
  }

  @Get('bases')
  getBases(@Query() query: AirtableCollectionQueryDto) {
    return this.airtableDataService.listBases(query);
  }

  @Get('tables')
  getTables(@Query() query: AirtableCollectionQueryDto) {
    return this.airtableDataService.listTables(query);
  }

  @Get('pages')
  getPages(@Query() query: AirtableCollectionQueryDto) {
    return this.airtableDataService.listPages(query);
  }

  @Get('users')
  getUsers(@Query() query: AirtableCollectionQueryDto) {
    return this.airtableDataService.listUsers(query);
  }

  @Get('revision-history')
  getRevisionHistory(@Query() query: AirtableCollectionQueryDto) {
    return this.airtableDataService.listRevisionHistory(query);
  }

  @Get('scrape-jobs')
  getScrapeJobs(@Query() query: AirtableScrapeJobQueryDto) {
    return this.airtableDataService.listScrapeJobs(query);
  }

  @Get('scrape-jobs/:jobId')
  getScrapeJob(
    @Param('jobId') jobId: string,
    @Query('integrationKey') integrationKey?: string,
  ) {
    return this.airtableDataService.getScrapeJob(jobId, integrationKey);
  }
}
