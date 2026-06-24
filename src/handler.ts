export const run = async (event: any) => {
  const time = new Date();
  console.log(`Your cron function ran at ${time}`);
};
