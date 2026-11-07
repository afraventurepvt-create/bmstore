import { Module } from '@nestjs/common';
import { CryptoModule } from '../crypto/crypto.module';
import { StoreController } from './store.controller';

@Module({ imports: [CryptoModule], controllers: [StoreController] })
export class StoreModule {}
