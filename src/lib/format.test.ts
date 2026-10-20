import { describe, expect, it } from 'vitest'
import { splitClientTin } from './format'

describe('splitClientTin', () => {
  it('normalizes a 9-digit TIN and keeps the branch field', () => {
    expect(splitClientTin('123456789', '')).toEqual({ tin: '123-456-789', branch: '00000' })
    expect(splitClientTin(' 123-456-789 ', '001')).toEqual({ tin: '123-456-789', branch: '001' })
  })

  it('takes a branch code typed after the TIN', () => {
    expect(splitClientTin('123-456-789-00002', '00000')).toEqual({ tin: '123-456-789', branch: '00002' })
    expect(splitClientTin('123456789000', '')).toEqual({ tin: '123-456-789', branch: '000' })
  })

  it('allows an empty TIN but rejects unreadable ones', () => {
    expect(splitClientTin('', '')).toEqual({ tin: '', branch: '00000' })
    expect(splitClientTin('12345678', '')).toBeNull()
    expect(splitClientTin('1234567890', '')).toBeNull()
    expect(splitClientTin('123456789', '12')).toBeNull()
  })
})
