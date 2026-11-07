import { Module } from '@nestjs/common';
import { CryptoModule } from '../crypto/crypto.module';
import { StorePublicController } from './public.controller';
import { StoreController } from './store.controller';

@Module({ imports: [CryptoModule], controllers: [StoreController, StorePublicController] })
export class StoreModule {}
