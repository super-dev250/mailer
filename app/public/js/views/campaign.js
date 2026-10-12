// One campaign: the editor while it is a draft, the report once it has started.

import { onMounted, ref } from '/vendor/vue.js';
import { api } from '../api.js';
import { problem } from '../store.js';
import { CampaignEditor } from './editor.js';
import { CampaignReport } from './report.js';

export const CampaignView = {
  components: { CampaignEditor, CampaignReport },
  props: { id: Number },
  setup(props) {
    const data = ref(null);
    const missing = ref(false);
    const load = () =>
      api.get(`/api/campaigns/${props.id}`).then(
        (result) => (data.value = result),
        (error) => {
          // A failed refresh keeps showing what is already on screen.
          missing.value = !data.value;
          problem(error);
        },
      );
    onMounted(load);
    return { data, missing, load };
  },
  template: `
    <template v-if="data">
      <CampaignEditor v-if="data.campaign.status === 'draft'" :campaign="data.campaign" @started="load" />
      <CampaignReport v-else :campaign="data.campaign" :stats="data.stats" @changed="load" />
    </template>
    <div v-else-if="missing" class="empty">
      <h2>This campaign could not be opened</h2>
      <a class="btn" href="#/campaigns">Back to campaigns</a>
    </div>`,
};
