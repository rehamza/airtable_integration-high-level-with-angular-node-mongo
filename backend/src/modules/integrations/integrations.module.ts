import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Integration, IntegrationSchema } from './schemas/integration.schema';
import { IntegrationsService } from './services/integrations.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: Integration.name,
        schema: IntegrationSchema,
      },
    ]),
  ],
  providers: [IntegrationsService],
  exports: [MongooseModule, IntegrationsService],
})
export class IntegrationsModule {}
