export const isAvailableAsync = async (): Promise<boolean> => false;
export const shareAsync = async (): Promise<never> => {
  throw new Error("[stub] expo-sharing.shareAsync not mocked in this test");
};
