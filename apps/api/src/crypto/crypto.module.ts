import { Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { TenantSecretsService } from './tenant-secrets.service';

@Module({ providers: [CryptoService, TenantSecretsService], exports: [CryptoService, TenantSecretsService] })
export class CryptoModule {}
