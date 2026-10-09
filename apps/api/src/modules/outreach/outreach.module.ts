import { Module } from '@nestjs/common';
import { OutreachController } from './outreach.controller.js';
import { OutreachService } from './outreach.service.js';

@Module({
  controllers: [OutreachController],
  providers: [OutreachService],
  exports: [OutreachService],
})
export class OutreachModule {}
