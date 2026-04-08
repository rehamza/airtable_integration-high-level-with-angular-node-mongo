import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { envBoolean, envNumber } from './config/env.utils';
import { AirtableModule } from './modules/airtable/airtable.module';
import { GridModule } from './modules/grid/grid.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      expandVariables: true,
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>('MONGODB_URI') ?? 'mongodb://127.0.0.1:27017',
        dbName: configService.get<string>('MONGODB_DB_NAME') ?? 'airtable_integration_system',
        autoIndex: envBoolean(configService.get<string>('MONGODB_AUTO_INDEX'), true),
        maxPoolSize: envNumber(configService.get<string>('MONGODB_MAX_POOL_SIZE'), 10),
        serverSelectionTimeoutMS: envNumber(
          configService.get<string>('MONGODB_SERVER_SELECTION_TIMEOUT_MS'),
          5000,
        ),
        retryAttempts: 1,
        retryDelay: 0,
        lazyConnection: true,
      }),
    }),
    IntegrationsModule,
    AirtableModule,
    GridModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
