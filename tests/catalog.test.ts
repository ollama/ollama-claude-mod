import { expect, test } from 'claude-code/testing'
import { modelChoices, modelLabel } from '../hooks/catalog'

const model = (name: string, isCloud = name.endsWith(':cloud') || name.endsWith('-cloud')) => ({ name, isCloud, isDecision: false })

test('picker deduplicates only latest aliases and preserves exact selected IDs and variants', () => {
  const models = ['glm-5.3:cloud', 'glm-5.3:latest-cloud', 'glm-5.3', 'glm-5.3:latest', 'glm-5.3:q4', 'glm-5.4:cloud'].map(name => model(name))
  expect(modelChoices(models).map(item => item.name)).toEqual(['glm-5.3', 'glm-5.3:cloud', 'glm-5.3:q4', 'glm-5.4:cloud'])
  expect(modelChoices(models, 'glm-5.3:latest-cloud').map(item => item.name)).toContain('glm-5.3:latest-cloud')
  expect(modelChoices(models, ['glm-5.3:cloud', 'glm-5.3:latest-cloud']).map(item => item.name)).toHaveLength(5)
})

test('available recommendations lead the picker with friendly labels and no invented models', () => {
  const models = ['other', 'deepseek-v4.1-flash:cloud', 'kimi-k3.1-pro:cloud', 'kimi-k3.1:cloud'].map(name => model(name))
  const choices = modelChoices(models)
  expect(choices.map(item => item.name)).toEqual(['kimi-k3.1-pro:cloud', 'deepseek-v4.1-flash:cloud', 'kimi-k3.1:cloud', 'other'])
  expect(choices.map(modelLabel)).toEqual(['Kimi K3.1 Pro · Cloud', 'DeepSeek V4.1 Flash · Cloud', 'Kimi K3.1 · Cloud', 'other'])
  expect(modelChoices([model('other')]).map(item => item.name)).toEqual(['other'])
})
